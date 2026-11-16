/*
 * Xiangqi online room: the two-player protocol on top of net.js.
 *
 * Both players keep the same small, versioned game state and publish it as a
 * retained message on their own sub-topic ('h' = host, 'g' = guest) every time
 * it changes. Because the whole state is re-published (not a stream of
 * deltas), a player who reloads, loses signal or joins late simply reads the
 * latest retained state, and nothing can get out of order or be missed.
 *
 *   state = {
 *     s    version, +1 on every change (higher wins),
 *     g    game number (a rematch starts a new one),
 *     hc   the host's colour 'r' | 'b' (random, swapped on each rematch),
 *     hid, gid   host / guest ids (gid is null until someone joins),
 *     m    moves as from*90+to,
 *     res  colour that resigned, or null,
 *     req  pending request {k:'undo'|'new', by, to?, declined?} or null,
 *     c    {r,b} clocks in ms when the state was published
 *   }
 *
 * Every adopted state is replayed through the rules engine, so an illegal
 * history is rejected whatever its source.
 */
(function (root) {
  'use strict';

  const X = root.Xiangqi || (typeof require === 'function' ? require('./game.js') : null);
  const Net = root.XQNet || (typeof require === 'function' ? require('./net.js') : null);

  const other = (c) => (c === 'r' ? 'b' : 'r');
  const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  const MISSING_AFTER_MS = 8000;

  function validState(st) {
    return !!st && typeof st === 'object' &&
      isInt(st.s, 0, 1e9) && isInt(st.g, 1, 1e6) &&
      (st.hc === 'r' || st.hc === 'b') &&
      typeof st.hid === 'string' && st.hid.length <= 32 &&
      (st.gid === null || (typeof st.gid === 'string' && st.gid.length <= 32)) &&
      Array.isArray(st.m) && st.m.length <= 800 && st.m.every((v) => isInt(v, 0, 8099)) &&
      (st.res === null || st.res === 'r' || st.res === 'b') &&
      (st.req === null || (typeof st.req === 'object' && (st.req.k === 'undo' || st.req.k === 'new') &&
        (st.req.by === 'r' || st.req.by === 'b'))) &&
      !!st.c && isInt(st.c.r, 0, 1e10) && isInt(st.c.b, 0, 1e10);
  }

  /** Rebuild a Game from a state, or null if the history is not legal. */
  function replay(st) {
    try {
      return X.Game.fromJSON({ moves: st.m.map((v) => [Math.floor(v / 90), v % 90]), resigned: st.res });
    } catch (err) {
      return null;
    }
  }

  class Room {
    /**
     * @param {object} o
     * @param {string} o.code        normalised challenge code
     * @param {'host'|'guest'} o.role
     * @param {string} [o.id]        this device's id (generated if missing)
     * @param {object} [o.saved]     previously saved state to resume from
     * @param {function} o.onChange  called with {type, ...} on every change
     */
    constructor({ code, role, id, saved, onChange, brokers, WebSocketImpl }) {
      this.code = code;
      this.role = role;
      this.id = id || Net.randomId();
      this.onChange = onChange || (() => {});
      this.brokers = brokers;
      this.WebSocketImpl = WebSocketImpl;
      this.net = 'connecting';
      this.peerOnline = null;
      this.presence = new Map(); // id -> last known online flag; may arrive before we know who the opponent is
      this.state = null;
      this.game = new X.Game();
      this.hostId = null;
      this.phase = role === 'host' ? 'waiting' : 'checking';
      this.closed = false;

      if (saved && validState(saved) && replay(saved)) {
        this.state = saved;
        this.game = replay(saved);
        this.hostId = saved.hid;
      } else if (role === 'host') {
        this.state = {
          s: 0, g: 1, hc: Math.random() < 0.5 ? 'r' : 'b', hid: this.id, gid: null,
          m: [], res: null, req: null, c: { r: 0, b: 0 },
        };
      }
      if (this.state) this.phase = this.state.gid ? 'playing' : 'waiting';
    }

    get myColor() {
      const st = this.state;
      if (!st) return null;
      if (this.role === 'host') return st.hc;
      return st.gid === this.id ? other(st.hc) : null;
    }

    get peerId() {
      const st = this.state;
      if (!st) return null;
      return this.role === 'host' ? st.gid : st.hid;
    }

    get mySub() {
      return this.role === 'host' ? 'h' : 'g';
    }

    snapshot() {
      return { code: this.code, role: this.role, id: this.id, state: this.state };
    }

    async start() {
      this.link = new Net.Link({
        code: this.code,
        clientId: this.id,
        brokers: this.brokers,
        WebSocketImpl: this.WebSocketImpl,
        will: { sub: 'p/' + this.id, obj: { k: 'pres', id: this.id, on: false } },
        onMessage: (sub, obj) => this._onMessage(sub, obj),
        onStatus: (status) => {
          this.net = status;
          this._emit({ type: 'net' });
        },
      });
      await this.link.start();
      this.link.publish('p/' + this.id, { k: 'pres', id: this.id, on: true });
      if (this.role === 'host') this._publish();
      else if (this.state) this._publish();
      else this.link.publish('g', { k: 'join', id: this.id });
      if (this.phase === 'checking') {
        this.missingTimer = setTimeout(() => {
          if (this.phase === 'checking' && !this.closed) this._setPhase('missing');
        }, MISSING_AFTER_MS);
      }
    }

    nudge() {
      if (this.link) this.link.nudge();
    }

    async leave() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.missingTimer);
      if (this.link) {
        await this.link.publish('p/' + this.id, { k: 'pres', id: this.id, on: false });
        this.link.close();
      }
    }

    /* ----------------------------------------------------------- inbound */

    _emit(change) {
      if (!this.closed) this.onChange(change);
    }

    _setPhase(phase) {
      if (this.phase === phase) return;
      this.phase = phase;
      this._emit({ type: 'phase' });
    }

    _onMessage(sub, obj) {
      if (this.closed) return;
      if (sub === 'h' && obj.k === 'state') this._onState(obj.st, 'h');
      else if (sub === 'g' && obj.k === 'state') this._onState(obj.st, 'g');
      else if (sub === 'g' && obj.k === 'join') this._onJoin(obj.id);
      else if (sub.startsWith('p/') && obj.k === 'pres') this._onPresence(obj);
    }

    _onPresence(p) {
      if (typeof p.id !== 'string' || p.id.length > 32 || typeof p.on !== 'boolean') return;
      this.presence.set(p.id, p.on);
      this._refreshPeer();
    }

    _refreshPeer() {
      const on = this.peerId && this.presence.has(this.peerId) ? this.presence.get(this.peerId) : null;
      if (on !== null && this.peerOnline !== on) {
        this.peerOnline = on;
        this._emit({ type: 'peer' });
      }
    }

    _onJoin(id) {
      if (this.role !== 'host' || typeof id !== 'string' || id.length > 32 || id === this.id) return;
      if (!this.state.gid) {
        this.state = { ...this.state, gid: id, s: this.state.s + 1 };
        this.phase = 'playing';
        this._publish();
        this._emit({ type: 'state', kind: 'joined' });
        this._emit({ type: 'phase' });
        this._refreshPeer();
      } else if (this.state.gid === id) {
        this._publish(); // the guest reconnected: confirm their seat again
      }
    }

    _better(st, from) {
      const cur = this.state;
      if (!cur) return true;
      if (st.g !== cur.g) return st.g > cur.g;
      if (st.s !== cur.s) return st.s > cur.s;
      // Same version but different content can only be a rare simultaneous
      // action; the host's copy is the tie-breaker.
      return this.role === 'guest' && from === 'h' &&
        (st.m.length !== cur.m.length || st.res !== cur.res || JSON.stringify(st.req) !== JSON.stringify(cur.req)) &&
        st.m.length >= cur.m.length;
    }

    _onState(st, from) {
      if (!validState(st)) return;
      if (this.role === 'host') {
        // Only our guest's own topic can move our state forward.
        if (from !== 'g' || !this.state.gid || st.gid !== this.state.gid || st.hid !== this.state.hid) return;
        if (this._better(st, from)) this._adopt(st, from);
        return;
      }
      if (from === 'h') {
        if (this.hostId && st.hid !== this.hostId) return;
        this.hostId = st.hid;
        if (st.gid && st.gid !== this.id) {
          if (!this.state) {
            clearTimeout(this.missingTimer);
            this._setPhase('full');
          }
          return;
        }
        if (!st.gid) {
          if (!this.state) {
            clearTimeout(this.missingTimer);
            this._setPhase('waiting');
            this.link.publish('g', { k: 'join', id: this.id }); // retry in case the host missed it
          }
          return;
        }
      } else if (st.gid !== this.id || (this.hostId && st.hid !== this.hostId)) {
        return; // our own retained copy is only useful if it is really ours
      }
      if (this._better(st, from)) this._adopt(st, from);
    }

    _adopt(st, from) {
      const game = replay(st);
      if (!game) return;
      const prev = this.state;
      this.state = st;
      this.game = game;
      this.hostId = st.hid;
      clearTimeout(this.missingTimer);

      let kind = 'sync';
      if (!prev) kind = 'init';
      else if (prev.g !== st.g) kind = 'newgame';
      else if (st.res && !prev.res) kind = 'resign';
      else if (st.m.length === prev.m.length + 1 && prev.m.every((v, i) => v === st.m[i])) kind = 'move';
      else if (st.m.length < prev.m.length) kind = 'undo';

      this._emit({ type: 'state', kind, from: prev ? prev.m.length : 0 });
      this._setPhase(st.gid ? 'playing' : 'waiting');
      this._refreshPeer();
      // Keep our retained copy current so a later reconnect finds the latest state.
      if (!(this.role === 'guest' && from === 'g')) this._publish();
    }

    /* ---------------------------------------------------------- outbound */

    _publish() {
      if (this.link && this.state) this.link.publish(this.mySub, { k: 'state', st: this.state });
    }

    _commit(next, kind) {
      this.state = { ...next, s: this.state.s + 1 };
      this.game = replay(this.state) || this.game;
      this._publish();
      this._emit({ type: 'state', kind, mine: true });
    }

    /** Play a move for this device's colour. Returns the engine record or null. */
    move(from, to, clocks) {
      const st = this.state;
      if (this.phase !== 'playing' || this.game.isOver || this.game.turn !== this.myColor) return null;
      const record = this.game.move(from, to);
      if (!record) return null;
      this.state = { ...st, s: st.s + 1, m: [...st.m, from * 90 + to], req: null, c: clocks || st.c };
      this._publish();
      this._emit({ type: 'state', kind: 'move', mine: true });
      return record;
    }

    resign() {
      if (this.phase !== 'playing' || this.game.isOver) return false;
      this._commit({ ...this.state, res: this.myColor, req: null }, 'resign');
      return true;
    }

    /** History length we would go back to if the opponent agrees, or -1. */
    undoTarget() {
      const st = this.state;
      if (this.phase !== 'playing' || this.game.isOver || !st.m.length) return -1;
      const pending = st.req && !st.req.declined;
      if (pending) return -1;
      const lastMover = (st.m.length - 1) % 2 === 0 ? 'r' : 'b';
      const to = lastMover === this.myColor ? st.m.length - 1 : st.m.length - 2;
      return to >= 0 ? to : -1;
    }

    /** Ask the opponent for a takeback ('undo') or a rematch ('new'). */
    request(kind) {
      const st = this.state;
      if (this.phase !== 'playing') return false;
      if (kind === 'undo') {
        const to = this.undoTarget();
        if (to < 0) return false;
        this._commit({ ...st, req: { k: 'undo', by: this.myColor, to } }, 'request');
        return true;
      }
      if (kind === 'new' && this.game.isOver && !(st.req && !st.req.declined)) {
        this._commit({ ...st, req: { k: 'new', by: this.myColor } }, 'request');
        return true;
      }
      return false;
    }

    /** Answer the opponent's pending request. */
    respond(accept) {
      const st = this.state;
      const req = st && st.req;
      if (!req || req.declined || req.by === this.myColor || this.phase !== 'playing') return false;
      if (!accept) {
        this._commit({ ...st, req: { ...req, declined: true } }, 'declined');
        return true;
      }
      if (req.k === 'undo') {
        if (!isInt(req.to, 0, st.m.length - 1) || this.game.isOver) return false;
        this._commit({ ...st, m: st.m.slice(0, req.to), req: null }, 'undo');
      } else {
        this._commit({
          ...st, g: st.g + 1, hc: other(st.hc), m: [], res: null, req: null, c: { r: 0, b: 0 },
        }, 'newgame');
      }
      return true;
    }
  }

  const api = { Room, validState, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XQOnline = api;
})(typeof self !== 'undefined' ? self : this);
