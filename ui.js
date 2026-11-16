/*
 * Xiangqi UI: canvas board renderer, input, timers, sound, persistence and
 * PWA plumbing. Depends on glyphs.js (XQ_GLYPHS) and game.js (Xiangqi).
 */
(function () {
  'use strict';

  const X = window.Xiangqi;
  const GLYPHS = window.XQ_GLYPHS;
  const Net = window.XQNet;
  const Online = window.XQOnline;

  const APP_VERSION = '1.1.0';
  const SAVE_KEY = 'xiangqi.save.v1';
  const BANNER_KEY = 'xiangqi.installBannerDismissed';
  const ONLINE_KEY = 'xiangqi.online.v1';

  const LABEL = {
    rK: '帥', rA: '仕', rE: '相', rH: '傌', rR: '俥', rC: '炮', rP: '兵',
    bK: '將', bA: '士', bE: '象', bH: '馬', bR: '車', bC: '砲', bP: '卒',
  };
  const INK = { r: '#b81d18', b: '#1d242b' };
  const SIDE_NAME = { r: 'RED', b: 'BLACK' };

  const MOVE_MS = 170;
  const AUTOPLAY_MS = 750;

  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const boardArea = $('board-area');
  const overlay = $('overlay');
  const toastEl = $('toast');

  /* ---------------------------------------------------------------- state */

  let localGame = new X.Game();
  let game = localGame; // the game on screen: the local one, or the online room's
  let view = 0; // number of moves shown; < history.length means reviewing
  const settings = { sound: true, flipped: false, tabletop: false };
  const localClock = { r: 0, b: 0 }; // thinking time per side, ms
  const onlineClock = { r: 0, b: 0 };
  let clock = localClock;
  let mode = 'local'; // 'local' (one device) or 'online' (two devices over the relay)
  let room = null; // active online room, kept connected even while viewing the local game
  let savedOnline = null;
  let selected = -1;
  let targets = [];
  let anim = null;
  let autoplay = null;
  let openPanel = null;

  const live = () => view === game.history.length;
  const online = () => mode === 'online' && !!room;
  const myTurn = () => !online() || (room.phase === 'playing' && game.turn === room.myColor);
  const flippedNow = () => (online() ? room.myColor === 'b' : settings.flipped);
  const roundClock = () => ({ r: Math.round(clock.r), b: Math.round(clock.b) });

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1,
        game: localGame.toJSON(),
        clock: { r: Math.round(localClock.r), b: Math.round(localClock.b) },
        settings,
        mode,
      }));
      if (room) {
        localStorage.setItem(ONLINE_KEY, JSON.stringify({
          v: 1,
          session: room.snapshot(),
          clock: { r: Math.round(onlineClock.r), b: Math.round(onlineClock.b) },
        }));
      } else {
        localStorage.removeItem(ONLINE_KEY);
      }
    } catch (err) {
      /* storage unavailable (private mode / quota): play on without saving */
    }
  }

  function restore() {
    try {
      const data = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (data) {
        for (const key of Object.keys(settings)) {
          if (typeof (data.settings || {})[key] === 'boolean') settings[key] = data.settings[key];
        }
        if (data.mode === 'online') mode = 'online';
        try {
          localGame = X.Game.fromJSON(data.game);
          localClock.r = Math.max(0, Number(data.clock && data.clock.r) || 0);
          localClock.b = Math.max(0, Number(data.clock && data.clock.b) || 0);
        } catch (err) {
          localGame = new X.Game();
        }
      }
    } catch (err) {
      /* corrupt save: start fresh */
    }
    try {
      const data = JSON.parse(localStorage.getItem(ONLINE_KEY));
      const sess = data && data.session;
      if (sess && Net.normCode(sess.code) && (sess.role === 'host' || sess.role === 'guest') && typeof sess.id === 'string') {
        savedOnline = data;
        onlineClock.r = Math.max(0, Number(data.clock && data.clock.r) || 0);
        onlineClock.b = Math.max(0, Number(data.clock && data.clock.b) || 0);
      }
    } catch (err) {
      /* ignore */
    }
    if (!savedOnline) mode = 'local';
    game = localGame;
    clock = localClock;
    view = game.history.length;
  }

  /* ---------------------------------------------------------------- sound */

  // Everything is synthesised with the Web Audio API: a pitched sine "thock",
  // a band-passed noise transient and a short triangle resonance together
  // read as a wooden disc being set down on a board.
  const Sound = (() => {
    let ac = null;
    let out = null;
    let noise = null;

    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        out = ac.createGain();
        out.gain.value = 0.9;
        out.connect(ac.destination);
        const length = Math.floor(ac.sampleRate * 0.12);
        noise = ac.createBuffer(1, length, ac.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      return ac;
    }

    function envelope(t, peak, attack, decay) {
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      gain.connect(out);
      return gain;
    }

    function knock(delay, level, pitch) {
      const t = ac.currentTime + delay;

      const body = ac.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(520 * pitch, t);
      body.frequency.exponentialRampToValueAtTime(170 * pitch, t + 0.07);
      body.connect(envelope(t, level * 0.9, 0.004, 0.11));
      body.start(t);
      body.stop(t + 0.14);

      const ring = ac.createOscillator();
      ring.type = 'triangle';
      ring.frequency.setValueAtTime(1180 * pitch, t);
      ring.connect(envelope(t, level * 0.22, 0.002, 0.05));
      ring.start(t);
      ring.stop(t + 0.07);

      const click = ac.createBufferSource();
      click.buffer = noise;
      const band = ac.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 2300 * pitch;
      band.Q.value = 1.4;
      click.connect(band);
      band.connect(envelope(t, level * 0.7, 0.001, 0.04));
      click.start(t);
      click.stop(t + 0.06);
    }

    function tone(delay, freq, dur, level, type) {
      const t = ac.currentTime + delay;
      const osc = ac.createOscillator();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(envelope(t, level, 0.01, dur));
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    const voices = {
      select: () => knock(0, 0.22, 1.7),
      move: () => knock(0, 0.8, 1),
      capture: () => {
        knock(0, 1, 0.82);
        knock(0.075, 0.55, 1.25);
      },
      check: () => {
        tone(0.06, 880, 0.16, 0.2, 'triangle');
        tone(0.2, 660, 0.24, 0.2, 'triangle');
      },
      win: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(0.15 + i * 0.13, f, 0.35, 0.2, 'triangle')),
    };

    return {
      unlock: ensure,
      play(name) {
        if (!settings.sound || !ensure()) return;
        try {
          voices[name]();
        } catch (err) {
          /* audio is a nicety; never let it break a move */
        }
      },
    };
  })();

  /* ------------------------------------------------------------- geometry */

  let dpr = 1;
  let geo = null; // { cell, frame, w, h, ox, oy, R }
  let boardLayer = null;
  const sprites = new Map();
  const glyphPaths = new Map();

  function glyphPath(ch) {
    let path = glyphPaths.get(ch);
    if (!path) {
      path = new Path2D(GLYPHS[ch].d);
      glyphPaths.set(ch, path);
    }
    return path;
  }

  function drawGlyph(c, ch, x, y, size, color, upsideDown) {
    c.save();
    c.translate(x, y);
    if (upsideDown) c.rotate(Math.PI);
    c.scale(size / 1000, size / 1000);
    c.fillStyle = color;
    c.fill(glyphPath(ch));
    c.restore();
  }

  function circle(c, x, y, r) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // Small deterministic PRNG so the wood grain is identical on every paint.
  function mulberry32(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function layout() {
    const rect = boardArea.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    // The board is 8 x 9 cells of grid plus a margin and frame on each side.
    const cell = Math.floor(Math.min(rect.width / 9.7, rect.height / 10.7) * dpr) / dpr;
    const w = Math.round(cell * 9.7);
    const h = Math.round(cell * 10.7);
    if (geo && geo.w === w && geo.h === h && geo.dpr === dpr) return;
    geo = {
      cell, w, h, dpr,
      frame: cell * 0.2,
      ox: (w - cell * 8) / 2,
      oy: (h - cell * 9) / 2,
      R: cell * 0.455,
    };
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    document.documentElement.style.setProperty('--board-w', w + 'px');
    sprites.clear();
    boardLayer = document.createElement('canvas');
    boardLayer.width = canvas.width;
    boardLayer.height = canvas.height;
    const c = boardLayer.getContext('2d');
    c.scale(dpr, dpr);
    paintBoard(c);
    draw();
  }

  /** Screen position of a board index, honouring the flipped setting. */
  function pos(i) {
    let r = X.rowOf(i);
    let col = X.colOf(i);
    if (flippedNow()) {
      r = 9 - r;
      col = 8 - col;
    }
    return { x: geo.ox + col * geo.cell, y: geo.oy + r * geo.cell };
  }

  function indexAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    let col = Math.round((clientX - rect.left - geo.ox) / geo.cell);
    let r = Math.round((clientY - rect.top - geo.oy) / geo.cell);
    if (r < 0 || r > 9 || col < 0 || col > 8) return -1;
    if (flippedNow()) {
      r = 9 - r;
      col = 8 - col;
    }
    return X.idx(r, col);
  }

  /* ------------------------------------------------------ static painting */

  function paintBoard(c) {
    const { w, h, cell, frame, ox, oy } = geo;
    const rand = mulberry32(20240607);

    // Bevelled frame.
    roundRect(c, 0, 0, w, h, cell * 0.2);
    let g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#b98c58');
    g.addColorStop(0.5, '#9e7346');
    g.addColorStop(1, '#7c5731');
    c.fillStyle = g;
    c.fill();
    c.save();
    c.clip();
    for (let i = 0; i < 40; i++) {
      c.strokeStyle = `rgba(60,35,12,${0.04 + rand() * 0.07})`;
      c.lineWidth = 0.5 + rand() * 1.2;
      const y = rand() * h;
      c.beginPath();
      c.moveTo(0, y);
      c.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 14, w * 0.7, y + (rand() - 0.5) * 14, w, y + (rand() - 0.5) * 8);
      c.stroke();
    }
    const bevel = Math.max(1.5, cell * 0.06);
    g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,233,188,0.8)');
    g.addColorStop(0.45, 'rgba(255,233,188,0.1)');
    g.addColorStop(0.55, 'rgba(40,20,5,0.1)');
    g.addColorStop(1, 'rgba(40,20,5,0.7)');
    c.strokeStyle = g;
    c.lineWidth = bevel;
    roundRect(c, bevel / 2, bevel / 2, w - bevel, h - bevel, cell * 0.2 - bevel / 2);
    c.stroke();
    c.restore();

    // Playing surface.
    const sx = frame;
    const sy = frame;
    const sw = w - frame * 2;
    const sh = h - frame * 2;
    c.save();
    roundRect(c, sx, sy, sw, sh, cell * 0.06);
    c.clip();
    g = c.createLinearGradient(sx, sy, sx + sw, sy + sh);
    g.addColorStop(0, '#d3ae78');
    g.addColorStop(0.5, '#cfa972');
    g.addColorStop(1, '#c39a60');
    c.fillStyle = g;
    c.fillRect(sx, sy, sw, sh);
    // Wood grain: long, slightly wavy streaks.
    for (let i = 0; i < 110; i++) {
      const light = rand() < 0.3;
      const alpha = 0.03 + rand() * 0.075;
      c.strokeStyle = light ? `rgba(255,236,196,${alpha})` : `rgba(122,82,36,${alpha})`;
      c.lineWidth = 0.5 + rand() * 1.8;
      const y = sy + rand() * sh;
      const wobble = cell * (0.1 + rand() * 0.35);
      c.beginPath();
      c.moveTo(sx, y);
      c.bezierCurveTo(
        sx + sw * 0.33, y + (rand() - 0.5) * wobble,
        sx + sw * 0.66, y + (rand() - 0.5) * wobble,
        sx + sw, y + (rand() - 0.5) * wobble
      );
      c.stroke();
    }
    // Recessed edge: shadow under the top/left lip, light on bottom/right.
    const lip = cell * 0.14;
    const edge = (x0, y0, x1, y1, color, rx, ry, rw, rh) => {
      const eg = c.createLinearGradient(x0, y0, x1, y1);
      eg.addColorStop(0, color);
      eg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = eg;
      c.fillRect(rx, ry, rw, rh);
    };
    edge(0, sy, 0, sy + lip, 'rgba(50,26,6,0.4)', sx, sy, sw, lip);
    edge(sx, 0, sx + lip, 0, 'rgba(50,26,6,0.32)', sx, sy, lip, sh);
    edge(0, sy + sh, 0, sy + sh - lip, 'rgba(255,238,200,0.22)', sx, sy + sh - lip, sw, lip);
    edge(sx + sw, 0, sx + sw - lip, 0, 'rgba(255,238,200,0.18)', sx + sw - lip, sy, lip, sh);
    c.restore();
    c.strokeStyle = 'rgba(58,34,12,0.8)';
    c.lineWidth = 1;
    roundRect(c, sx, sy, sw, sh, cell * 0.06);
    c.stroke();

    // Grid.
    const lw = Math.min(2.4, Math.max(1, cell * 0.036));
    const X0 = ox;
    const X1 = ox + cell * 8;
    const Y0 = oy;
    const Y1 = oy + cell * 9;
    c.strokeStyle = '#5e4324';
    c.lineWidth = lw;
    c.lineCap = 'butt';
    c.beginPath();
    for (let r = 0; r < 10; r++) {
      c.moveTo(X0, oy + r * cell);
      c.lineTo(X1, oy + r * cell);
    }
    for (let col = 0; col < 9; col++) {
      const x = ox + col * cell;
      if (col === 0 || col === 8) {
        c.moveTo(x, Y0 - lw / 2);
        c.lineTo(x, Y1 + lw / 2);
      } else {
        c.moveTo(x, Y0);
        c.lineTo(x, oy + 4 * cell);
        c.moveTo(x, oy + 5 * cell);
        c.lineTo(x, Y1);
      }
    }
    // Palace diagonals.
    for (const top of [0, 7]) {
      c.moveTo(ox + 3 * cell, oy + top * cell);
      c.lineTo(ox + 5 * cell, oy + (top + 2) * cell);
      c.moveTo(ox + 5 * cell, oy + top * cell);
      c.lineTo(ox + 3 * cell, oy + (top + 2) * cell);
    }
    c.stroke();

    // Heavier outer border, set slightly outside the grid.
    const off = cell * 0.1;
    c.lineWidth = lw * 2;
    c.strokeRect(X0 - off, Y0 - off, cell * 8 + off * 2, cell * 9 + off * 2);

    // L-shaped registration marks at cannon and soldier starting points.
    const marks = [[2, 1], [2, 7], [7, 1], [7, 7]];
    for (let col = 0; col < 9; col += 2) marks.push([3, col], [6, col]);
    const gap = cell * 0.1;
    const len = cell * 0.2;
    c.lineWidth = lw;
    c.lineCap = 'square';
    c.beginPath();
    for (const [r, col] of marks) {
      const x = ox + col * cell;
      const y = oy + r * cell;
      for (const dx of [-1, 1]) {
        if (col + dx < 0 || col + dx > 8) continue;
        for (const dy of [-1, 1]) {
          c.moveTo(x + dx * gap, y + dy * (gap + len));
          c.lineTo(x + dx * gap, y + dy * gap);
          c.lineTo(x + dx * (gap + len), y + dy * gap);
        }
      }
    }
    c.stroke();

    // River inscription, engraved: a light lower edge under a dark fill.
    const ry = oy + 4.5 * cell;
    const size = cell * 0.66;
    for (const [ch, col] of [['楚', 1.45], ['河', 2.85], ['漢', 4.85], ['界', 6.25]]) {
      const x = ox + col * cell;
      drawGlyph(c, ch, x, ry + Math.max(0.6, cell * 0.02), size, 'rgba(255,238,200,0.5)');
      drawGlyph(c, ch, x, ry, size, '#6e502c');
    }
  }

  function sprite(piece, upsideDown) {
    const key = piece + (upsideDown ? '!' : '');
    let cv = sprites.get(key);
    if (cv) return cv;
    const R = geo.R;
    const size = (R + R * 0.45) * 2;
    cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(size * dpr);
    cv.cssSize = cv.width / dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const m = cv.cssSize / 2;
    const ink = INK[piece[0]];

    // Drop shadow so the disc sits above the board. (Shadow metrics are in
    // device pixels and ignore the context transform.)
    c.save();
    c.shadowColor = 'rgba(32,16,3,0.62)';
    c.shadowBlur = R * 0.3 * dpr;
    c.shadowOffsetY = R * 0.17 * dpr;
    c.fillStyle = '#b08c57';
    circle(c, m, m, R * 0.98);
    c.fill();
    c.restore();

    // Rim / side wall.
    let g = c.createLinearGradient(0, m - R, 0, m + R);
    g.addColorStop(0, '#eedab0');
    g.addColorStop(0.5, '#d4b483');
    g.addColorStop(1, '#a5804a');
    c.fillStyle = g;
    circle(c, m, m, R);
    c.fill();
    const edge = Math.max(0.75, R * 0.035);
    c.strokeStyle = 'rgba(80,50,18,0.8)';
    c.lineWidth = edge;
    circle(c, m, m, R - edge / 2);
    c.stroke();

    // Face.
    g = c.createRadialGradient(m - R * 0.3, m - R * 0.36, R * 0.08, m, m, R * 0.92);
    g.addColorStop(0, '#fdf4e1');
    g.addColorStop(0.55, '#f3dfc1');
    g.addColorStop(1, '#e5cb9f');
    c.fillStyle = g;
    circle(c, m, m, R * 0.87);
    c.fill();
    c.strokeStyle = 'rgba(150,108,56,0.5)';
    c.lineWidth = Math.max(0.5, R * 0.03);
    c.stroke();

    // Inner ring in the piece's ink.
    c.save();
    c.globalAlpha = 0.78;
    c.strokeStyle = ink;
    c.lineWidth = Math.max(0.8, R * 0.05);
    circle(c, m, m, R * 0.71);
    c.stroke();
    c.restore();

    // Character, lightly engraved.
    const gs = R * 1.17;
    drawGlyph(c, LABEL[piece], m, m + Math.max(0.5, R * 0.03), gs, 'rgba(255,255,255,0.75)', upsideDown);
    drawGlyph(c, LABEL[piece], m, m, gs, ink, upsideDown);

    sprites.set(key, cv);
    return cv;
  }

  /* ------------------------------------------------------- frame painting */

  let frameQueued = false;

  function requestDraw() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      draw();
    });
  }

  function drawPiece(piece, x, y) {
    // In tabletop mode the far player's pieces face them across the table.
    const far = flippedNow() ? 'r' : 'b';
    const s = sprite(piece, settings.tabletop && !online() && piece[0] === far);
    ctx.drawImage(s, x - s.cssSize / 2, y - s.cssSize / 2, s.cssSize, s.cssSize);
  }

  function draw() {
    if (!geo) return;
    const { cell, R } = geo;
    const board = live() ? game.board : game.boardAt(view);
    const last = view > 0 ? game.history[view - 1] : null;

    let moving = null;
    if (anim) {
      const t = (performance.now() - anim.start) / MOVE_MS;
      if (t >= 1) {
        anim = null;
      } else {
        const e = 1 - Math.pow(1 - t, 3);
        const a = pos(anim.from);
        const b = pos(anim.to);
        moving = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
        requestDraw();
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(boardLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Move counter on the right edge of the river.
    ctx.fillStyle = '#6e502c';
    ctx.font = `600 ${Math.round(cell * 0.27)}px -apple-system, "Helvetica Neue", system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${view}/${game.history.length}`, geo.ox + cell * 8 - cell * 0.08, geo.oy + cell * 4.9);

    if (last) {
      // Origin of the last move: concentric target ring with a warm core.
      const o = pos(last.from);
      const glow = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, cell * 0.42);
      glow.addColorStop(0, 'rgba(242,140,107,0.55)');
      glow.addColorStop(1, 'rgba(242,140,107,0)');
      ctx.fillStyle = glow;
      circle(ctx, o.x, o.y, cell * 0.42);
      ctx.fill();
      ctx.strokeStyle = '#d93829';
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      circle(ctx, o.x, o.y, cell * 0.25);
      ctx.stroke();
      ctx.fillStyle = '#f28c6b';
      circle(ctx, o.x, o.y, cell * 0.12);
      ctx.fill();
      ctx.strokeStyle = '#d93829';
      ctx.lineWidth = Math.max(1, cell * 0.025);
      ctx.stroke();
    }

    // The checked General glows red.
    if (last && last.check && !anim) {
      const k = board.indexOf(X.other(last.piece[0]) + 'K');
      if (k >= 0) halo(pos(k), 'rgba(226,40,24,0.95)', 'rgba(226,40,24,0)', R * 1.55);
    }
    if (last && !anim) {
      const d = pos(last.to);
      ring(d, R + Math.max(1.5, cell * 0.035), 'rgba(217,56,41,0.9)', Math.max(1.5, cell * 0.045));
    }
    if (selected >= 0) {
      halo(pos(selected), 'rgba(255,196,60,0.95)', 'rgba(232,80,30,0)', R * 1.5);
    }

    for (let i = 0; i < board.length; i++) {
      if (!board[i] || (anim && i === anim.hide)) continue;
      const p = pos(i);
      drawPiece(board[i], p.x, p.y);
    }
    if (anim && anim.ghost) {
      const p = pos(anim.hide);
      drawPiece(anim.ghost, p.x, p.y);
    }

    if (selected >= 0) {
      const p = pos(selected);
      ring(p, R + Math.max(1, cell * 0.02), '#ffc93c', Math.max(2, cell * 0.06));
      ring(p, R + Math.max(3, cell * 0.075), 'rgba(217,56,41,0.9)', Math.max(1, cell * 0.025));
      for (const to of targets) {
        const q = pos(to);
        if (board[to]) {
          ring(q, R + Math.max(1, cell * 0.02), 'rgba(217,45,30,0.92)', Math.max(2.5, cell * 0.075));
        } else {
          ctx.fillStyle = 'rgba(38,112,58,0.62)';
          circle(ctx, q.x, q.y, cell * 0.15);
          ctx.fill();
          ctx.strokeStyle = 'rgba(240,255,235,0.6)';
          ctx.lineWidth = Math.max(1, cell * 0.025);
          ctx.stroke();
        }
      }
    }

    if (moving) drawPiece(anim.piece, moving.x, moving.y);
  }

  function ring(p, radius, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    circle(ctx, p.x, p.y, radius);
    ctx.stroke();
  }

  function halo(p, inner, outer, radius) {
    const g = ctx.createRadialGradient(p.x, p.y, radius * 0.55, p.x, p.y, radius);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    circle(ctx, p.x, p.y, radius);
    ctx.fill();
  }

  /* ------------------------------------------------------------------ HUD */

  function glyphSVG(text, color, pad) {
    const NS = 'http://www.w3.org/2000/svg';
    const box = 1000 + (pad || 0) * 2;
    const frag = document.createDocumentFragment();
    for (const ch of text) {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `${-box / 2} ${-box / 2} ${box} ${box}`);
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', GLYPHS[ch].d);
      path.setAttribute('fill', color);
      svg.appendChild(path);
      frag.appendChild(svg);
    }
    return frag;
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function updateClock() {
    $('timer-r').textContent = formatTime(clock.r);
    $('timer-b').textContent = formatTime(clock.b);
  }

  function setTag(side, text, cls) {
    const el = $('tag-' + side);
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'tag' + (cls ? ' ' + cls : '');
  }

  function updateTags() {
    if (!online()) {
      setTag('r');
      setTag('b');
      return;
    }
    const me = room.myColor;
    for (const side of ['r', 'b']) {
      if (!me) setTag(side);
      else if (side === me) setTag(side, room.net === 'online' ? 'YOU' : 'YOU · OFFLINE', room.net === 'online' ? '' : 'bad');
      else if (room.phase !== 'playing') setTag(side, 'NOT JOINED', 'dim');
      else if (room.peerOnline === true) setTag(side, '● ONLINE', 'ok');
      else if (room.peerOnline === false) setTag(side, '○ AWAY', 'bad');
      else setTag(side, '… LINKING', 'dim');
    }
  }

  function updateHUD() {
    document.body.classList.toggle('online', online());
    for (const side of ['r', 'b']) {
      const card = $('card-' + side);
      card.classList.toggle('active', !game.isOver && game.turn === side && (!online() || room.phase === 'playing'));
      card.classList.toggle('winner', game.isOver && game.winner === side);
    }
    updateTags();
    const total = game.history.length;
    const undo = $('btn-undo');
    undo.disabled = online() ? room.undoTarget() < 0 : total === 0;
    undo.setAttribute('aria-label', online() ? 'Ask opponent to take back a move' : 'Undo last move');
    $('btn-back').disabled = view === 0;
    $('btn-fwd').disabled = live();
    const play = $('btn-play');
    play.disabled = live();
    play.classList.toggle('playing', !!autoplay);
    play.classList.toggle('attn', !live() && !autoplay);
    play.setAttribute('aria-label', autoplay ? 'Jump to the current position' : 'Replay to the current position');
    const side = $('btn-tabletop');
    side.setAttribute('aria-pressed', String(!online() && settings.tabletop));
    side.setAttribute('aria-label', online() ? 'Game code and invite' : 'Face-to-face tabletop mode');
    $('menu-sound').textContent = 'Sound: ' + (settings.sound ? 'On' : 'Off');
    $('menu-local').setAttribute('aria-pressed', String(!online()));
    $('menu-online').setAttribute('aria-pressed', String(online()));
    $('menu-resign').disabled = !online() || room.phase !== 'playing' || game.isOver;
    updateClock();
  }

  let toastTimer = 0;

  function toast(text, alert, ms) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.toggle('alert', !!alert);
    toastEl.hidden = true; // restart the entrance animation
    void toastEl.offsetWidth;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, ms || 1600);
  }

  /* --------------------------------------------------------------- timers */

  let lastTick = performance.now();

  function clockRunning() {
    // Online, both devices must keep the same time, so menus never pause the clock.
    return !game.isOver && game.history.length > 0 && live() && (online() || !openPanel) &&
      (!online() || room.phase === 'playing') && document.visibilityState === 'visible';
  }

  function tick() {
    const now = performance.now();
    const delta = Math.min(now - lastTick, 1000); // never credit a long sleep
    lastTick = now;
    if (!clockRunning()) return;
    const before = Math.floor(clock[game.turn] / 1000);
    clock[game.turn] += delta;
    const after = Math.floor(clock[game.turn] / 1000);
    if (after !== before) {
      updateClock();
      if (after % 5 === 0) save();
    }
  }

  /* ----------------------------------------------------------------- play */

  function clearSelection() {
    selected = -1;
    targets = [];
  }

  function stopAutoplay() {
    if (autoplay) {
      clearInterval(autoplay);
      autoplay = null;
    }
  }

  function announce(record) {
    if (record.status !== 'playing') {
      Sound.play('win');
      setTimeout(showResult, MOVE_MS + 350);
    } else if (record.check) {
      Sound.play('check');
      toast('將軍 · Check!', true);
    }
  }

  function playMove(from, to) {
    const record = online() ? room.move(from, to, roundClock()) : game.move(from, to);
    if (!record) return;
    clearSelection();
    view = game.history.length;
    anim = { piece: record.piece, from, to, hide: to, ghost: record.captured, start: performance.now() };
    Sound.play(record.captured ? 'capture' : 'move');
    announce(record);
    lastTick = performance.now();
    save();
    updateHUD();
    requestDraw();
  }

  function onBoardTap(event) {
    event.preventDefault();
    Sound.unlock();
    if (!geo) return;
    const i = indexAt(event.clientX, event.clientY);
    if (!live()) {
      toast('Reviewing — press ▶ to return to the game');
      return;
    }
    if (game.isOver) {
      showResult();
      return;
    }
    if (!myTurn()) {
      clearSelection();
      toast(room.phase === 'playing' ? "Opponent's turn" : 'Waiting for your opponent to join');
      requestDraw();
      return;
    }
    if (i < 0) {
      clearSelection();
    } else if (selected >= 0 && targets.includes(i)) {
      playMove(selected, i);
      return;
    } else if (game.pieceAt(i) && game.pieceAt(i)[0] === game.turn && i !== selected) {
      selected = i;
      targets = game.legalMovesFrom(i);
      Sound.play('select');
    } else {
      clearSelection();
    }
    requestDraw();
  }

  function undo() {
    if (online()) {
      requestTakeback();
      return;
    }
    stopAutoplay();
    clearSelection();
    const record = game.undo();
    if (!record) return;
    view = game.history.length;
    anim = { piece: record.piece, from: record.to, to: record.from, hide: record.from, ghost: null, start: performance.now() };
    Sound.play('move');
    lastTick = performance.now();
    save();
    updateHUD();
    requestDraw();
  }

  /** Show the position after `n` moves, animating single steps. */
  function goTo(n) {
    const target = Math.max(0, Math.min(n, game.history.length));
    if (target === view) return;
    clearSelection();
    if (target === view + 1) {
      const m = game.history[view];
      anim = { piece: m.piece, from: m.from, to: m.to, hide: m.to, ghost: m.captured, start: performance.now() };
      Sound.play(m.captured ? 'capture' : 'move');
    } else if (target === view - 1) {
      const m = game.history[target];
      anim = { piece: m.piece, from: m.to, to: m.from, hide: m.from, ghost: null, start: performance.now() };
      Sound.play('select');
    } else {
      anim = null;
    }
    view = target;
    lastTick = performance.now();
    updateHUD();
    requestDraw();
  }

  function togglePlay() {
    if (autoplay) {
      // Second press: skip straight to the live position.
      stopAutoplay();
      goTo(game.history.length);
      updateHUD();
      return;
    }
    if (live()) return;
    goTo(view + 1);
    if (!live()) {
      autoplay = setInterval(() => {
        goTo(view + 1);
        if (live()) {
          stopAutoplay();
          updateHUD();
        }
      }, AUTOPLAY_MS);
    }
    updateHUD();
  }

  function newGame() {
    stopAutoplay();
    clearSelection();
    anim = null;
    localGame = new X.Game();
    game = localGame;
    view = 0;
    localClock.r = localClock.b = 0;
    save();
    closePanel();
    updateHUD();
    requestDraw();
    Sound.play('move');
  }

  /* --------------------------------------------------------------- modals */

  function showPanel(id) {
    for (const panel of overlay.querySelectorAll('.panel')) panel.hidden = panel.id !== id;
    overlay.hidden = false;
    openPanel = id;
    const first = $(id).querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function closePanel() {
    overlay.hidden = true;
    openPanel = null;
    lastTick = performance.now();
  }

  function renderResultButtons() {
    const on = online();
    const btn = $('result-new');
    $('result-undo').hidden = on;
    $('result-leave').hidden = !on;
    const req = on && room.state.req;
    const waiting = !!(req && req.k === 'new' && !req.declined && req.by === room.myColor);
    btn.textContent = !on ? 'New Game' : waiting ? 'Waiting for opponent…' : 'Rematch';
    btn.disabled = waiting;
  }

  function showResult() {
    if (!game.isOver || openPanel === 'panel-request') return;
    const mate = game.status === 'checkmate';
    const resigned = game.status === 'resigned';
    const me = online() ? room.myColor : null;
    const holder = $('result-glyphs');
    holder.textContent = '';
    holder.appendChild(glyphSVG(
      mate ? '將死' : resigned ? (game.winner === 'r' ? '紅' : '黑') + '勝' : '困斃',
      '#fff0cf', 40
    ));
    const reason = mate ? 'Checkmate' : resigned
      ? (online() ? (game.resigned === me ? 'You resigned' : 'Your opponent resigned') : `${SIDE_NAME[game.resigned]} resigned`)
      : 'Stalemate: no legal move';
    if (online() && me) {
      $('result-title').textContent = game.winner === me ? 'You Win!' : 'You Lose';
      $('result-text').textContent = reason + '.';
    } else {
      $('result-title').textContent = mate ? 'Checkmate' : resigned ? 'Resigned' : 'Stalemate';
      $('result-text').textContent = mate || resigned
        ? `${SIDE_NAME[game.winner]} wins the game.`
        : `${SIDE_NAME[X.other(game.winner)]} has no legal move — ${SIDE_NAME[game.winner]} wins.`;
    }
    renderResultButtons();
    showPanel('panel-result');
  }

  /* --------------------------------------------------------- online play */

  let lastNet = '';
  let declinedSeen = -1;
  let confirmYes = null;
  const sideName = (c) => (c === 'r' ? 'RED' : 'BLACK');

  function askConfirm(title, text, yes, fn) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yes;
    confirmYes = fn;
    showPanel('panel-confirm');
  }

  function makeRoom(opts) {
    return new Online.Room({ ...opts, onChange: onRoomChange });
  }

  function switchMode(next) {
    stopAutoplay();
    clearSelection();
    anim = null;
    mode = next === 'online' && room ? 'online' : 'local';
    game = mode === 'online' ? room.game : localGame;
    clock = mode === 'online' ? onlineClock : localClock;
    view = game.history.length;
    lastTick = performance.now();
    save();
    updateHUD();
    requestDraw();
  }

  function startRoom(r, fresh) {
    if (room) room.leave();
    room = r;
    savedOnline = null;
    if (fresh) onlineClock.r = onlineClock.b = 0;
    switchMode('online');
    r.start().catch(() => {
      lobbyError('Online play needs a secure (https) connection.');
    });
  }

  function createGame() {
    try {
      startRoom(makeRoom({ code: Net.genCode(), role: 'host' }), true);
    } catch (err) {
      lobbyError('Online play needs a secure (https) connection.');
      return;
    }
    showLobby();
  }

  function joinGame(raw) {
    const code = Net.normCode(raw);
    if (!code) {
      lobbyError('Enter the 6-character code your friend sent you.');
      return;
    }
    try {
      startRoom(makeRoom({ code, role: 'guest' }), true);
    } catch (err) {
      lobbyError('Online play needs a secure (https) connection.');
      return;
    }
    showLobby();
  }

  function resumeOnline() {
    const { session, clock: saved } = savedOnline;
    room = makeRoom({ code: session.code, role: session.role, id: session.id, saved: session.state });
    onlineClock.r = Math.max(0, Number(saved && saved.r) || 0);
    onlineClock.b = Math.max(0, Number(saved && saved.b) || 0);
    mode = 'online';
    game = room.game;
    clock = onlineClock;
    view = game.history.length;
    savedOnline = null;
    room.start().catch(() => {});
  }

  function leaveOnline() {
    const r = room;
    room = null;
    if (r) r.leave();
    switchMode('local');
    closePanel();
    toast('Left the online game');
  }

  function lobbyError(text) {
    const el = $('join-error');
    el.textContent = text;
    el.hidden = false;
    if (openPanel !== 'panel-online') showPanel('panel-online');
  }

  function showLobby(prefill) {
    if (prefill) $('join-code').value = Net.prettyCode(prefill);
    $('join-error').hidden = true;
    renderLobby();
    showPanel('panel-online');
  }

  function renderLobby() {
    const panel = $('panel-online');
    const inRoom = !!room;
    for (const v of panel.querySelectorAll('[data-view]')) v.hidden = (v.dataset.view === 'room') !== inRoom;
    if (!inRoom) return;
    $('room-code').textContent = Net.prettyCode(room.code);
    const status = $('room-status');
    const bad = room.phase === 'missing' || room.phase === 'full';
    const offline = room.net !== 'online';
    let text;
    if (room.phase === 'full') text = 'That game already has two players.';
    else if (room.phase === 'missing') {
      text = offline
        ? "Can't reach the game server. Check your internet connection and try again."
        : 'No game found with that code. Check it, and make sure your friend has created the game.';
    } else if (room.phase === 'checking') text = offline ? 'Connecting to the game server…' : 'Looking for the game…';
    else if (room.phase === 'waiting') {
      text = room.role === 'host'
        ? (offline ? 'Connecting to the game server…' : 'Waiting for your opponent to join. Send them this code.')
        : 'Joined. Waiting for the host to start…';
    } else {
      text = `Connected. You play ${sideName(room.myColor)}. ` +
        (room.peerOnline === false ? 'Your opponent is away.' : 'Your opponent is online.');
    }
    status.textContent = text;
    status.classList.toggle('error', bad);
    const playing = room.phase === 'playing';
    $('room-leave').textContent = bad ? 'Back' : playing ? 'Leave Game' : 'Cancel Game';
    $('room-close').hidden = bad;
    $('room-copy').hidden = bad;
    $('room-share').hidden = bad;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err2) {
        /* ignore */
      }
      area.remove();
      return ok;
    }
  }

  const inviteLink = () => `${location.origin}/?join=${room.code}`;

  async function shareInvite() {
    if (!room) return;
    const text = `Play Xiangqi (Chinese Chess) with me! Challenge code: ${Net.prettyCode(room.code)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Xiangqi challenge', text, url: inviteLink() });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    toast((await copyText(`${text}\n${inviteLink()}`)) ? 'Invite copied' : 'Could not copy the invite');
  }

  function requestTakeback() {
    if (!online()) return;
    if (room.request('undo')) toast('Takeback requested. Waiting for your opponent…', false, 2200);
    else toast('You can take back a move after you have played one');
  }

  function requestRematch() {
    if (online() && room.request('new')) {
      renderResultButtons();
      toast('Rematch requested');
    }
  }

  function checkRequests() {
    if (!online()) return;
    const st = room.state;
    const req = st.req;
    const me = room.myColor;
    if (req && !req.declined && req.by !== me && room.phase === 'playing') {
      const rematch = req.k === 'new';
      $('request-title').textContent = rematch ? 'Rematch?' : 'Take back a move?';
      $('request-text').textContent = rematch
        ? 'Your opponent would like to play again. Colours will swap.'
        : 'Your opponent asks to take back their last move.';
      if (openPanel !== 'panel-request') showPanel('panel-request');
    } else {
      if (openPanel === 'panel-request') {
        closePanel();
        if (game.isOver) showResult();
      }
      if (req && req.declined && req.by === me && declinedSeen !== st.s) {
        declinedSeen = st.s;
        toast('Your opponent declined', true);
        if (openPanel === 'panel-result') renderResultButtons();
      }
    }
  }

  function applyRoomState(c) {
    const st = room.state;
    const len = game.history.length;
    const rec = len ? game.history[len - 1] : null;
    if (c.mine) {
      if (c.kind === 'resign') showResult();
      else if (c.kind === 'undo') {
        clearSelection();
        view = len;
        toast('Move taken back');
      } else if (c.kind === 'newgame') resetForNewGame();
      else if (c.kind === 'declined') {
        if (openPanel === 'panel-request') closePanel();
        if (game.isOver) showResult();
      }
      return;
    }
    if (c.kind === 'move' && rec) {
      const wasLive = view === c.from;
      clock.r = st.c.r;
      clock.b = st.c.b;
      if (wasLive) {
        view = len;
        anim = { piece: rec.piece, from: rec.from, to: rec.to, hide: rec.to, ghost: rec.captured, start: performance.now() };
        Sound.play(rec.captured ? 'capture' : 'move');
        announce(rec);
      } else if (rec.status !== 'playing') {
        announce(rec);
      } else {
        toast('Your opponent moved');
      }
      lastTick = performance.now();
    } else if (c.kind === 'undo') {
      clearSelection();
      anim = null;
      view = len;
      Sound.play('select');
      toast('Move taken back');
    } else if (c.kind === 'newgame') {
      resetForNewGame();
    } else if (c.kind === 'resign') {
      view = len;
      toast('Your opponent resigned');
      Sound.play('win');
      showResult();
    } else if (c.kind === 'init' || c.kind === 'sync' || c.kind === 'joined') {
      if (c.kind === 'init') {
        clock.r = st.c.r;
        clock.b = st.c.b;
      }
      if (view >= c.from || c.kind === 'init') view = len;
      view = Math.min(view, len);
      if (game.isOver && c.kind === 'init') setTimeout(showResult, 400);
    }
    checkRequests();
  }

  function resetForNewGame() {
    clearSelection();
    anim = null;
    view = 0;
    clock.r = clock.b = 0;
    if (openPanel === 'panel-result' || openPanel === 'panel-request') closePanel();
    toast(`New game. You play ${sideName(room.myColor)}`, false, 2200);
    Sound.play('select');
  }

  function onRoomChange(c) {
    if (!room) return;
    if (mode === 'online') game = room.game;
    if (c.type === 'net') {
      if (room.net === 'offline' && lastNet === 'online' && online()) toast('Connection lost. Reconnecting…', true, 2400);
      else if (room.net === 'online' && lastNet === 'offline' && online()) toast('Back online');
      lastNet = room.net;
    } else if (c.type === 'peer') {
      if (online() && room.phase === 'playing') toast(room.peerOnline ? 'Your opponent is back' : 'Your opponent went away', !room.peerOnline);
    } else if (c.type === 'phase') {
      if (room.phase === 'playing') {
        if (openPanel === 'panel-online') closePanel();
        if (online()) {
          toast(`Connected. You play ${sideName(room.myColor)}`, false, 2200);
          Sound.play('select');
        }
        lastTick = performance.now();
      }
    } else if (c.type === 'state') {
      if (mode === 'online') applyRoomState(c);
      else if (!c.mine && c.kind === 'move' && room.game.turn === room.myColor) toast('Online game: your turn');
    }
    save();
    updateHUD();
    if (openPanel === 'panel-online') renderLobby();
    requestDraw();
  }

  /* ------------------------------------------------------------------ PWA */

  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function setupInstallBanner() {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(BANNER_KEY) === '1';
    } catch (err) {
      /* ignore */
    }
    const banner = $('install-banner');
    if (isIOS() && !isStandalone() && !dismissed) banner.hidden = false;
    $('banner-close').addEventListener('click', () => {
      banner.hidden = true;
      try {
        localStorage.setItem(BANNER_KEY, '1');
      } catch (err) {
        /* ignore */
      }
    });
    $('banner-how').addEventListener('click', () => showPanel('panel-install'));
  }

  function setupServiceWorker() {
    const status = (text) => {
      $('menu-status').textContent = `v${APP_VERSION} · ${text}`;
      $('install-status').textContent = text;
    };
    if (!('serviceWorker' in navigator)) {
      status('Offline mode is not supported by this browser');
      return;
    }
    status('Preparing offline mode…');
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => status(isStandalone() ? 'Installed · ready to play offline' : 'Ready to play offline'))
        .catch(() => status('Offline mode unavailable (needs HTTPS)'));
    });
  }

  let wakeLock = null;

  async function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (err) {
      /* not granted: the screen may dim, nothing else changes */
    }
  }

  /* ----------------------------------------------------------------- init */

  function bind() {
    canvas.addEventListener('pointerdown', onBoardTap);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    $('btn-undo').addEventListener('click', undo);
    $('btn-back').addEventListener('click', () => {
      stopAutoplay();
      goTo(view - 1);
      updateHUD();
    });
    $('btn-fwd').addEventListener('click', () => {
      stopAutoplay();
      goTo(view + 1);
      updateHUD();
    });
    $('btn-play').addEventListener('click', togglePlay);
    $('btn-tabletop').addEventListener('click', () => {
      if (online()) {
        showLobby();
        return;
      }
      settings.tabletop = !settings.tabletop;
      toast(settings.tabletop ? 'Face-to-face: far side rotated 180°' : 'Face-to-face off');
      save();
      updateHUD();
      requestDraw();
    });
    $('btn-menu').addEventListener('click', () => showPanel('panel-menu'));

    $('menu-new').addEventListener('click', () => {
      if (game.history.length) {
        askConfirm('New Game?', 'The current game and its move history will be cleared.', 'New Game', newGame);
      } else {
        newGame();
      }
    });
    $('confirm-yes').addEventListener('click', () => {
      const fn = confirmYes;
      confirmYes = null;
      closePanel();
      if (fn) fn();
    });
    $('menu-local').addEventListener('click', () => {
      closePanel();
      if (online()) switchMode('local');
    });
    $('menu-online').addEventListener('click', () => {
      if (room) {
        switchMode('online');
        if (room.phase === 'playing') closePanel();
        else showLobby();
      } else {
        showLobby();
      }
    });
    $('menu-code').addEventListener('click', () => showLobby());
    $('menu-resign').addEventListener('click', () => {
      askConfirm('Resign?', 'Your opponent will win this game.', 'Resign', () => room && room.resign());
    });
    $('menu-leave').addEventListener('click', () => {
      askConfirm('Leave online game?', 'You will not be able to rejoin unless you still have the code.', 'Leave', leaveOnline);
    });
    $('online-create').addEventListener('click', createGame);
    $('online-join').addEventListener('click', () => joinGame($('join-code').value));
    $('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinGame($('join-code').value);
    });
    $('join-code').addEventListener('input', () => {
      $('join-error').hidden = true;
    });
    $('room-copy').addEventListener('click', async () => {
      if (room) toast((await copyText(Net.prettyCode(room.code))) ? 'Code copied' : 'Could not copy the code');
    });
    $('room-share').addEventListener('click', shareInvite);
    $('room-leave').addEventListener('click', leaveOnline);
    $('request-yes').addEventListener('click', () => room && room.respond(true));
    $('request-no').addEventListener('click', () => room && room.respond(false));
    $('menu-flip').addEventListener('click', () => {
      settings.flipped = !settings.flipped;
      save();
      closePanel();
      requestDraw();
      toast(settings.flipped ? 'Black now plays from the bottom' : 'Red now plays from the bottom');
    });
    $('menu-sound').addEventListener('click', () => {
      settings.sound = !settings.sound;
      save();
      updateHUD();
      Sound.play('move');
    });
    $('menu-install').addEventListener('click', () => showPanel('panel-install'));
    $('result-new').addEventListener('click', () => (online() ? requestRematch() : newGame()));
    $('result-leave').addEventListener('click', leaveOnline);
    $('result-undo').addEventListener('click', () => {
      closePanel();
      undo();
    });

    overlay.addEventListener('click', (e) => {
      if (openPanel === 'panel-request') return; // must be answered
      if (e.target === overlay || e.target.closest('[data-close]')) closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openPanel && openPanel !== 'panel-request') closePanel();
    });

    // First touch anywhere unlocks audio (required by iOS) and the wake lock.
    document.addEventListener('pointerdown', () => {
      Sound.unlock();
      keepAwake();
    }, { passive: true });

    // Belt and braces against pinch / double-tap zoom in standalone mode.
    for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }

    document.addEventListener('visibilitychange', () => {
      lastTick = performance.now();
      if (document.visibilityState === 'visible') {
        keepAwake();
        if (room) room.nudge();
      } else {
        save();
      }
    });
    window.addEventListener('online', () => room && room.nudge());
    window.addEventListener('pagehide', save);

    new ResizeObserver(layout).observe(boardArea);
    window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  }

  function init() {
    restore();
    $('medal-b').appendChild(glyphSVG('將', INK.b, 260));
    $('medal-r').appendChild(glyphSVG('帥', INK.r, 260));
    bind();
    setupInstallBanner();
    setupServiceWorker();
    if (mode === 'online' && savedOnline) resumeOnline();
    updateHUD();
    layout();
    setInterval(tick, 250);
    if (game.isOver) setTimeout(showResult, 500);
    handleInviteLink();
    if (room) checkRequests();
  }

  /** Opening the app with ?join=ABC-DEF in the address starts joining that game. */
  function handleInviteLink() {
    let code = null;
    try {
      code = Net.normCode(new URLSearchParams(location.search).get('join'));
      if (location.search) history.replaceState(null, '', location.pathname);
    } catch (err) {
      return;
    }
    if (!code) return;
    if (room && room.code === code) {
      switchMode('online');
    } else if (room) {
      askConfirm('Join a new game?', `You are in an online game. Leave it and join ${Net.prettyCode(code)}?`, 'Leave & Join', () => {
        leaveOnline();
        joinGame(code);
      });
    } else {
      showLobby(code);
      joinGame(code);
    }
  }

  init();
})();
