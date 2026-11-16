#!/usr/bin/env node
/*
 * Minimal static server for local development (`npm start`). It applies the
 * headers from vercel.json so the Content-Security-Policy and cache rules can
 * be exercised before deploying. Not used in production.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).headers.map((rule) => ({
  test: new RegExp('^' + rule.source + '$'),
  headers: rule.headers,
}));

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(ROOT, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  for (const rule of rules) {
    if (rule.test.test(pathname)) for (const { key, value } of rule.headers) res.setHeader(key, value);
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Xiangqi running at http://localhost:${PORT}`));
