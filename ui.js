/*
 * Xiangqi UI: canvas board renderer, input, timers, sound, persistence and
 * PWA plumbing. Depends on glyphs.js (XQ_GLYPHS) and game.js (Xiangqi).
 */
(function () {
  'use strict';

  const X = window.Xiangqi;
  const GLYPHS = window.XQ_GLYPHS;

  const APP_VERSION = '1.0.0';
  const SAVE_KEY = 'xiangqi.save.v1';
  const BANNER_KEY = 'xiangqi.installBannerDismissed';

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

  let game = new X.Game();
  let view = 0; // number of moves shown; < history.length means reviewing
  const settings = { sound: true, flipped: false, tabletop: false };
  const clock = { r: 0, b: 0 }; // thinking time per side, ms
  let selected = -1;
  let targets = [];
  let anim = null;
  let autoplay = null;
  let openPanel = null;

  const live = () => view === game.history.length;

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1,
        game: game.toJSON(),
        clock: { r: Math.round(clock.r), b: Math.round(clock.b) },
        settings,
      }));
    } catch (err) {
      /* storage unavailable (private mode / quota): play on without saving */
    }
  }

  function restore() {
    try {
      const data = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (!data) return;
      for (const key of Object.keys(settings)) {
        if (typeof (data.settings || {})[key] === 'boolean') settings[key] = data.settings[key];
      }
      game = X.Game.fromJSON(data.game);
      clock.r = Math.max(0, Number(data.clock && data.clock.r) || 0);
      clock.b = Math.max(0, Number(data.clock && data.clock.b) || 0);
    } catch (err) {
      game = new X.Game();
      clock.r = clock.b = 0;
    }
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
    if (settings.flipped) {
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
    if (settings.flipped) {
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
    const far = settings.flipped ? 'r' : 'b';
    const s = sprite(piece, settings.tabletop && piece[0] === far);
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

  function updateHUD() {
    for (const side of ['r', 'b']) {
      const card = $('card-' + side);
      card.classList.toggle('active', !game.isOver && game.turn === side);
      card.classList.toggle('winner', game.isOver && game.winner === side);
    }
    const total = game.history.length;
    $('btn-undo').disabled = total === 0;
    $('btn-back').disabled = view === 0;
    $('btn-fwd').disabled = live();
    const play = $('btn-play');
    play.disabled = live();
    play.classList.toggle('playing', !!autoplay);
    play.classList.toggle('attn', !live() && !autoplay);
    play.setAttribute('aria-label', autoplay ? 'Jump to the current position' : 'Replay to the current position');
    $('btn-tabletop').setAttribute('aria-pressed', String(settings.tabletop));
    $('menu-sound').textContent = 'Sound: ' + (settings.sound ? 'On' : 'Off');
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
    return !game.isOver && game.history.length > 0 && live() && !openPanel &&
      document.visibilityState === 'visible';
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
    const record = game.move(from, to);
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
    game = new X.Game();
    view = 0;
    clock.r = clock.b = 0;
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

  function showResult() {
    if (!game.isOver) return;
    const mate = game.status === 'checkmate';
    const holder = $('result-glyphs');
    holder.textContent = '';
    holder.appendChild(glyphSVG(mate ? '將死' : '困斃', '#fff0cf', 40));
    $('result-title').textContent = mate ? 'Checkmate' : 'Stalemate';
    $('result-text').textContent = mate
      ? `${SIDE_NAME[game.winner]} wins the game.`
      : `${SIDE_NAME[X.other(game.winner)]} has no legal move — ${SIDE_NAME[game.winner]} wins.`;
    showPanel('panel-result');
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
      settings.tabletop = !settings.tabletop;
      toast(settings.tabletop ? 'Face-to-face: far side rotated 180°' : 'Face-to-face off');
      save();
      updateHUD();
      requestDraw();
    });
    $('btn-menu').addEventListener('click', () => showPanel('panel-menu'));

    $('menu-new').addEventListener('click', () => {
      if (game.history.length) showPanel('panel-confirm');
      else newGame();
    });
    $('confirm-yes').addEventListener('click', newGame);
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
    $('result-new').addEventListener('click', newGame);
    $('result-undo').addEventListener('click', () => {
      closePanel();
      undo();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openPanel) closePanel();
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
      if (document.visibilityState === 'visible') keepAwake();
      else save();
    });
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
    updateHUD();
    layout();
    setInterval(tick, 250);
    if (game.isOver) setTimeout(showResult, 500);
  }

  init();
})();
