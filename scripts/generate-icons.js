#!/usr/bin/env node
/*
 * Generates the app icons (icons/icon-{180,192,512}.png) with nothing but
 * Node's standard library: a tiny supersampling rasteriser paints a red
 * General (帥) disc on dark wood, and a minimal PNG encoder writes the file.
 *
 * The PNGs are committed, so hosting needs no build step. Re-run with
 *   node scripts/generate-icons.js
 * only if the artwork changes.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const GLYPHS = require('../glyphs.js');

const SIZES = [180, 192, 512];
const SS = 4; // supersampling factor per axis

/* ---------- PNG ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode opaque 8-bit RGB pixels (Uint8Array of size*size*3) as a PNG. */
function encodePNG(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha (iOS wants opaque icons)
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- glyph rasteriser ---------- */

/** Parse an "M/L/Q/Z" path into closed polygons (curves flattened). */
function flatten(d) {
  const polys = [];
  let poly = null;
  let x = 0;
  let y = 0;
  for (const [, op, args] of d.matchAll(/([MLQZ])([^MLQZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (op === 'M') {
      poly = [[n[0], n[1]]];
      polys.push(poly);
      [x, y] = n;
    } else if (op === 'L') {
      poly.push([n[0], n[1]]);
      [x, y] = n;
    } else if (op === 'Q') {
      const [cx, cy, ex, ey] = n;
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        const u = 1 - t;
        poly.push([u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey]);
      }
      x = ex;
      y = ey;
    }
  }
  return polys;
}

/** Non-zero winding scanline fill of a glyph into a size x size bitmap. */
function glyphMask(ch, size, centre, scale) {
  const mask = new Uint8Array(size * size);
  const edges = [];
  for (const poly of flatten(GLYPHS[ch].d)) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      if (y0 !== y1) edges.push([x0 * scale + centre, y0 * scale + centre, x1 * scale + centre, y1 * scale + centre]);
    }
  }
  for (let row = 0; row < size; row++) {
    const y = row + 0.5;
    const hits = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        hits.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    for (let i = 0; i < hits.length - 1; i++) {
      winding += hits[i][1];
      if (winding !== 0) {
        const from = Math.max(0, Math.ceil(hits[i][0] - 0.5));
        const to = Math.min(size - 1, Math.floor(hits[i + 1][0] - 0.5));
        for (let col = from; col <= to; col++) mask[row * size + col] = 1;
      }
    }
  }
  return mask;
}

/* ---------- artwork ---------- */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)));
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const WOOD_TOP = hex('#5b4026');
const WOOD_BOTTOM = hex('#33200f');
const RIM_TOP = hex('#f0dcb2');
const RIM_BOTTOM = hex('#a27c46');
const FACE_LIGHT = hex('#fdf4e1');
const FACE_MID = hex('#f3dfc1');
const FACE_DARK = hex('#e2c697');
const EDGE = hex('#5a3a16');
const RED = hex('#b81d18');
const GOLD = hex('#c89d54');
const WHITE = [255, 255, 255];
const BLACK = [20, 10, 2];

function render(size) {
  const N = size * SS;
  const R = 0.385; // disc radius (inside the maskable safe zone)
  const glyph = glyphMask('帥', N, N / 2, (N * 0.5) / 1000);
  const bump = Math.round(N * 0.006);
  const acc = new Float64Array(size * size * 3);

  for (let py = 0; py < N; py++) {
    const v = (py + 0.5) / N;
    for (let px = 0; px < N; px++) {
      const u = (px + 0.5) / N;

      // Dark wood table with vertical grain and a soft vignette.
      const grain =
        Math.sin(u * 61 + Math.sin(v * 5.3) * 2.2) * 0.5 +
        Math.sin(u * 173 + Math.sin(v * 3.1 + 1.7) * 3.1) * 0.3 +
        Math.sin(u * 419 + v * 2.3) * 0.2;
      let c = mix(WOOD_TOP, WOOD_BOTTOM, v);
      c = mix(c, grain > 0 ? WHITE : BLACK, Math.abs(grain) * 0.07);
      c = mix(c, BLACK, smooth(0.42, 0.78, Math.hypot(u - 0.5, v - 0.5)) * 0.45);

      // Gold inlay ring around the piece.
      const d = Math.hypot(u - 0.5, v - 0.5);
      c = mix(c, GOLD, (1 - smooth(0.004, 0.007, Math.abs(d - (R + 0.045)))) * 0.85);

      // Drop shadow.
      const ds = Math.hypot(u - 0.5, v - 0.53);
      c = mix(c, BLACK, (1 - smooth(R - 0.03, R + 0.06, ds)) * 0.7);

      if (d <= R) {
        c = mix(RIM_TOP, RIM_BOTTOM, (v - (0.5 - R)) / (2 * R));
        if (d > R - 0.006) c = mix(c, EDGE, 0.75);
        if (d <= R * 0.87) {
          const dl = Math.hypot(u - 0.5 + R * 0.3, v - 0.5 + R * 0.36) / (R * 1.25);
          c = dl < 0.55 ? mix(FACE_LIGHT, FACE_MID, dl / 0.55) : mix(FACE_MID, FACE_DARK, (dl - 0.55) / 0.45);
          if (d > R * 0.87 - 0.004) c = mix(c, EDGE, 0.3);
          if (Math.abs(d - R * 0.71) < 0.0075) c = mix(c, RED, 0.8);
          if (py >= bump && glyph[(py - bump) * N + px]) c = mix(c, WHITE, 0.75);
          if (glyph[py * N + px]) c = RED;
        }
      }

      const o = (Math.floor(py / SS) * size + Math.floor(px / SS)) * 3;
      acc[o] += c[0];
      acc[o + 1] += c[1];
      acc[o + 2] += c[2];
    }
  }

  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.round(acc[i] / (SS * SS));
  return rgb;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
