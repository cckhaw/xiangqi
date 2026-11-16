'use strict';
// Static checks that the PWA is internally consistent: everything the page
// loads is precached, every precached / manifest / icon path exists, and the
// app makes no request to any other origin (so offline caching is complete).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (url) => fs.existsSync(path.join(ROOT, url === '/' ? 'index.html' : url.replace(/^\//, '')));

const sw = read('sw.js');
const precache = [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const html = read('index.html');
const manifest = JSON.parse(read('manifest.json'));
const vercel = JSON.parse(read('vercel.json'));

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' is not a PNG');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test('service worker precache: root paths only, every file exists', () => {
  assert.ok(precache.length >= 8);
  for (const url of precache) {
    assert.ok(url.startsWith('/'), url + ' must be a root path');
    assert.ok(exists(url), 'precached file missing: ' + url);
  }
  assert.equal(new Set(precache).size, precache.length, 'duplicate precache entries');
});

test('every local asset referenced by index.html is precached', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 6);
  for (const ref of refs) {
    assert.ok(ref.startsWith('/') && !ref.startsWith('//'), 'not a root-relative local path: ' + ref);
    assert.ok(exists(ref), 'referenced file missing: ' + ref);
    assert.ok(precache.includes(ref), 'not precached: ' + ref);
  }
  for (const required of ['/', '/index.html', '/manifest.json']) assert.ok(precache.includes(required));
});

test('service worker lifecycle: install precache, activate cleanup, fetch fallback', () => {
  assert.match(sw, /addEventListener\('install'/);
  assert.match(sw, /cache\.addAll/);
  assert.match(sw, /addEventListener\('activate'/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(read('ui.js'), /serviceWorker\.register\('\/sw\.js'/);
});

test('manifest: standalone, root scoped, icons exist with declared sizes', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.orientation, 'portrait');
  assert.ok(manifest.theme_color && manifest.background_color);
  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(exists(icon.src), 'icon missing: ' + icon.src);
    assert.ok(precache.includes(icon.src), 'icon not precached: ' + icon.src);
    const { width, height } = pngSize(icon.src.slice(1));
    assert.equal(`${width}x${height}`, icon.sizes);
    sizes.add(icon.sizes);
  }
  assert.deepEqual([...sizes].sort(), ['180x180', '192x192', '512x512']);
});

test('icons are opaque PNGs (required for a crisp iOS Home Screen icon)', () => {
  for (const size of [180, 192, 512]) {
    const info = pngSize(`icons/icon-${size}.png`);
    assert.deepEqual(info, { width: size, height: size, colorType: 2 });
  }
});

test('Apple PWA meta tags are present', () => {
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\/icons\/icon-180\.png">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
});

test('vercel.json: no-cache for sw.js and manifest.json, security headers, no git previews', () => {
  const headersFor = (source) => {
    const rule = vercel.headers.find((r) => r.source === source);
    assert.ok(rule, 'no header rule for ' + source);
    return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
  };
  assert.match(headersFor('/sw.js')['Cache-Control'], /no-cache/);
  assert.match(headersFor('/manifest.json')['Cache-Control'], /no-cache/);
  const all = headersFor('/(.*)');
  for (const key of ['X-Content-Type-Options', 'Referrer-Policy', 'Content-Security-Policy']) {
    assert.ok(all[key], 'missing security header ' + key);
  }
  // Framing: only this origin and the games portal may embed the app. This is enforced with CSP
  // frame-ancestors; an X-Frame-Options header would also block the portal, so it must not be set.
  const ancestors = all['Content-Security-Policy'].match(/frame-ancestors ([^;]+)/);
  assert.ok(ancestors, 'CSP must set frame-ancestors');
  assert.deepEqual(ancestors[1].trim().split(/\s+/), ["'self'", 'https://games.khaw.cc']);
  assert.equal(all['X-Frame-Options'], undefined, 'X-Frame-Options would block the games portal');
  assert.equal(vercel.git.deploymentEnabled, false);
});

test('online relay: every broker the app may use is allowed by the CSP, and nothing else is', () => {
  const Net = require('../net.js');
  const rule = vercel.headers.find((r) => r.source === '/(.*)');
  const csp = rule.headers.find((h) => h.key === 'Content-Security-Policy').value;
  const connect = csp.match(/connect-src ([^;]+)/)[1].split(/\s+/);
  const allowed = connect.filter((src) => src.startsWith('wss://')).sort();
  const used = Net.BROKERS.map((url) => { const u = new URL(url); return `wss://${u.host}`; }).sort();
  assert.deepEqual(allowed, used);
  assert.ok(connect.includes("'self'"));
  assert.ok(Net.BROKERS.every((url) => url.startsWith('wss://')), 'brokers must use TLS');
  for (const file of ['/net.js', '/online.js']) assert.ok(precache.includes(file), file + ' not precached');
  const net = read('net.js');
  const urls = [...net.matchAll(/['"](wss?:\/\/[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), Net.BROKERS.slice().sort(), 'net.js contains URLs other than BROKERS');
});

test('zero external dependencies: no remote URLs, inline scripts or inline styles', () => {
  const xmlns = /http:\/\/www\.w3\.org\/2000\/svg/g;
  for (const file of ['index.html', 'styles.css', 'ui.js', 'game.js', 'net.js', 'online.js', 'sw.js', 'manifest.json']) {
    const text = read(file).replace(xmlns, '');
    assert.doesNotMatch(text, /https?:\/\//, file + ' references a remote URL');
    assert.doesNotMatch(text, /@import|url\(/, file + ' pulls in another resource');
  }
  // Required by the Content-Security-Policy in vercel.json.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline <script> found');
  assert.doesNotMatch(html, /<style|\sstyle="/, 'inline style found');
  assert.doesNotMatch(html, /\son[a-z]+="/, 'inline event handler found');
});
