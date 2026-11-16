#!/usr/bin/env node
/*
 * Two-device browser test of Internet play (needs Playwright + Chromium).
 *
 *   npm start &                          # serves http://localhost:4173
 *   node scripts/verify-online.js [outDir]
 *
 * Two independent browser contexts (two "phones") run the real app. Their
 * WebSocket traffic to the public MQTT brokers is intercepted and served by
 * the in-process test broker, so no internet is needed. Covers create/join by
 * code, invite link, orientation, tapping moves on both devices, takeback and
 * rematch prompts, resign, reload resume, relay outage and recovery, and a
 * full room. Screenshots go to outDir.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { BrokerCore, attachToRoute } = require('../tests/helpers/mini-broker.js');

const APP = process.env.APP_URL || 'http://localhost:4173/';
const OUT = process.argv[2] || '.';
const broker = new BrokerCore();

async function phone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await context.routeWebSocket(/broker\.(emqx\.io|hivemq\.com)|test\.mosquitto\.org/, (ws) => attachToRoute(broker, ws));
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForFunction(() => document.getElementById('board').width > 100);
  return { name, context, page, errors, flipped: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, file) => p.page.screenshot({ path: path.join(OUT, `online-${file}.png`) });

async function tapSquare(p, sq) {
  const r = await p.page.evaluate(() => document.getElementById('board').getBoundingClientRect().toJSON());
  const cell = r.width / 9.7;
  let col = sq.charCodeAt(0) - 97;
  let row = 9 - Number(sq[1]);
  if (p.flipped) { col = 8 - col; row = 9 - row; }
  await p.page.touchscreen.tap(r.x + r.width / 2 + (col - 4) * cell, r.y + r.height / 2 + (row - 4.5) * cell);
  await sleep(300);
}
const move = async (p, from, to) => { await tapSquare(p, from); await tapSquare(p, to); };
const online = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem('xiangqi.online.v1') || 'null'));
const moves = async (p) => ((await online(p)) || { session: { state: { m: [] } } }).session.state.m.length;
const visible = (p, sel) => p.page.locator(sel).isVisible();
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  assert.fail('timed out: ' + what);
}
const tapId = (p, id) => p.page.locator(id).tap();

(async () => {
  const browser = await chromium.launch();
  const A = await phone(browser, 'A');
  const B = await phone(browser, 'B');

  // ---- A creates a game
  await tapId(A, '#btn-menu');
  await tapId(A, '#menu-online');
  await tapId(A, '#online-create');
  await waitFor(() => visible(A, '#room-code'), 'room code shown');
  const code = (await A.page.locator('#room-code').textContent()).replace('-', '');
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  await waitFor(async () => /Waiting for your opponent/.test(await A.page.locator('#room-status').textContent()), 'host waiting status');
  await shot(A, 'lobby-host');
  const m = await A.page.evaluate(() => { const p = document.getElementById('panel-online').getBoundingClientRect(); return { r: p.right <= innerWidth && p.bottom <= innerHeight, sw: document.scrollingElement.scrollWidth <= innerWidth }; });
  assert.deepEqual(m, { r: true, sw: true }, 'lobby fits the phone');

  // ---- B joins with the code (typed lower-case with a dash, as a person might)
  await tapId(B, '#btn-menu');
  await tapId(B, '#menu-online');
  await tapId(B, '#join-code');
  await B.page.keyboard.type((code.slice(0, 3) + '-' + code.slice(3)).toLowerCase());
  await shot(B, 'lobby-join');
  await tapId(B, '#online-join');
  await waitFor(async () => !(await visible(A, '#panel-online')) && !(await visible(B, '#panel-online')), 'both lobbies close');
  await waitFor(async () => (await A.page.locator('.tag').allTextContents()).some((t) => t === 'YOU'), 'A seated');
  const redIsA = (await A.page.locator('#card-r .tag').textContent()) === 'YOU';
  const red = redIsA ? A : B;
  const black = redIsA ? B : A;
  red.flipped = false;
  black.flipped = true;
  assert.equal(await red.page.locator('#card-r .tag').textContent(), 'YOU');
  await waitFor(async () => /ONLINE/.test(await red.page.locator('#card-b .tag').textContent()), 'red sees black online');
  await waitFor(async () => /ONLINE/.test(await black.page.locator('#card-r .tag').textContent()), 'black sees red online');
  assert.equal(await black.page.locator('#card-b .tag').textContent(), 'YOU');
  await shot(red, 'start-red');
  await shot(black, 'start-black-flipped');

  // ---- turn enforcement and moves, tapping like a person
  await move(black, 'h7', 'e7'); // not black's turn: nothing happens
  assert.equal(await moves(red), 0);
  assert.match(await black.page.locator('#toast').textContent(), /Opponent's turn/);
  await move(red, 'h2', 'e2');
  await waitFor(async () => (await moves(black)) === 1, 'black receives the move');
  await move(black, 'h7', 'e7');
  await waitFor(async () => (await moves(red)) === 2, 'red receives the reply');
  await shot(black, 'play-black');

  // ---- takeback: red asks, black accepts; both rewind two plies
  assert.equal(await red.page.locator('#btn-undo').isDisabled(), false);
  await tapId(red, '#btn-undo');
  await waitFor(() => visible(black, '#panel-request'), 'black sees the takeback prompt');
  await shot(black, 'request');
  await tapId(black, '#request-yes');
  await waitFor(async () => (await moves(red)) === 0 && (await moves(black)) === 0, 'both rewound');
  // ...and a declined one
  await move(red, 'h2', 'e2');
  await waitFor(async () => (await moves(black)) === 1, 'sync');
  await tapId(red, '#btn-undo');
  await waitFor(() => visible(black, '#panel-request'), 'second prompt');
  await tapId(black, '#request-no');
  await waitFor(async () => /declined/.test(await red.page.locator('#toast').textContent()), 'red told it was declined');
  assert.equal(await moves(red), 1);

  // ---- reload black mid-game: seat, board and orientation come back
  await black.page.reload();
  await black.page.waitForFunction(() => document.getElementById('board').width > 100);
  await waitFor(async () => (await black.page.locator('#card-b .tag').textContent()) === 'YOU', 'black resumed');
  await move(black, 'h7', 'e7');
  await waitFor(async () => (await moves(red)) === 2, 'resumed black can play');

  // ---- relay outage: everyone is dropped, play carries on after reconnecting
  broker.dropAll();
  await sleep(300);
  await move(red, 'e2', 'e6'); // played while (maybe) offline; delivered on reconnect
  await waitFor(async () => (await moves(black)) === 3, 'move delivered after reconnect', 15000);

  // ---- a third phone with the same code is turned away
  const C = await phone(browser, 'C');
  await C.page.goto(`${APP}?join=${code}`);
  await waitFor(async () => /already has two players/.test(await C.page.locator('#room-status').textContent()), 'third player refused');
  await shot(C, 'full');
  await C.context.close();

  // ---- resign, result screens, rematch with swapped colours
  await tapId(black, '#btn-menu');
  await tapId(black, '#menu-resign');
  await tapId(black, '#confirm-yes');
  await waitFor(() => visible(red, '#panel-result'), 'red sees the result');
  assert.equal(await red.page.locator('#result-title').textContent(), 'You Win!');
  assert.match(await red.page.locator('#result-text').textContent(), /resigned/);
  assert.equal(await black.page.locator('#result-title').textContent(), 'You Lose');
  await shot(red, 'result-win');
  await tapId(red, '#result-new');
  await waitFor(() => visible(black, '#panel-request'), 'black sees the rematch prompt');
  await tapId(black, '#request-yes');
  await waitFor(async () => (await online(red)).session.state.g === 2 && (await online(black)).session.state.g === 2, 'game 2');
  await waitFor(async () => (await black.page.locator('#card-r .tag').textContent()) === 'YOU', 'colours swapped');
  red.flipped = true;
  black.flipped = false;
  await move(black, 'h2', 'e2'); // black player is red now
  await waitFor(async () => (await moves(red)) === 1, 'rematch plays');
  await shot(black, 'rematch');

  // ---- leaving returns to the untouched local game
  await tapId(A, '#btn-menu');
  await tapId(A, '#menu-leave');
  await tapId(A, '#confirm-yes');
  await waitFor(async () => !(await A.page.evaluate(() => document.body.classList.contains('online'))), 'A is back in local mode');
  assert.equal(await online(A), null);
  await waitFor(async () => (await B.page.locator('.tag.bad, .tag').allTextContents()).some((t) => /AWAY/.test(t)), 'B sees A leave');
  await tapId(A, '#btn-menu');
  assert.equal(await A.page.locator('#menu-new').isVisible(), true);
  assert.equal(await A.page.locator('#menu-resign').isVisible(), false);
  await tapId(A, '#menu-local');

  for (const p of [A, B]) assert.deepEqual(p.errors, [], `${p.name}: console errors`);
  console.log(`ok online: code ${code}, 2 phones, ${broker.log.length} relay messages, nothing but ciphertext:`,
    [...broker.retained.values()].every((b) => !/xiangqi|"m":|moves/.test(b.toString())));
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
