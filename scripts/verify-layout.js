#!/usr/bin/env node
/*
 * Browser smoke test (needs Playwright + Chromium; not part of `npm test`).
 *
 *   npm start &                      # serves http://localhost:4173
 *   node scripts/verify-layout.js [outDir]
 *
 * At iPhone (390x844) and iPad (820x1180) sizes it checks that nothing
 * scrolls or overflows, plays moves by tapping the canvas, confirms the game
 * survives a reload, and reloads once more with the network off to prove the
 * service worker serves the whole app offline. Screenshots go to outDir.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'http://localhost:4173/';
const OUT = process.argv[2] || '.';
const VIEWPORTS = [
  { name: 'iphone', width: 390, height: 844 },
  { name: 'ipad', width: 820, height: 1180 },
];

(async () => {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(String(e)));

    await page.goto(URL);
    await page.waitForFunction(() => document.getElementById('board').width > 100);

    const metrics = () => page.evaluate(() => {
      const el = document.scrollingElement;
      const inView = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
      };
      return {
        scrollW: el.scrollWidth, scrollH: el.scrollHeight, w: innerWidth, h: innerHeight,
        visible: ['players', 'board', 'actions'].every(inView),
        medalsFit: ['b', 'r'].every((side) => {
          const card = document.getElementById('card-' + side).getBoundingClientRect();
          const medal = document.getElementById('medal-' + side).getBoundingClientRect();
          return medal.height < card.height && medal.top > card.top && medal.left > card.left && medal.right < card.right;
        }),
        stacked: document.getElementById('players').getBoundingClientRect().bottom <=
          document.getElementById('board').getBoundingClientRect().top &&
          document.getElementById('board').getBoundingClientRect().bottom <=
          document.getElementById('actions').getBoundingClientRect().top,
        board: document.getElementById('board').getBoundingClientRect().toJSON(),
      };
    });
    let m = await metrics();
    assert.ok(m.scrollW <= m.w && m.scrollH <= m.h, `${vp.name}: page scrolls ${JSON.stringify(m)}`);
    assert.ok(m.visible, `${vp.name}: a zone is outside the viewport`);
    assert.ok(m.medalsFit && m.stacked, `${vp.name}: zones overlap ${JSON.stringify(m)}`);
    assert.ok(m.board.width > vp.width * 0.85 || m.board.height > vp.height * 0.6, `${vp.name}: board too small`);

    // Tap helper: board coordinates (file a-i, rank 0-9 from Red's side).
    const cell = m.board.width / 9.7;
    const tap = async (sq) => {
      const col = sq.charCodeAt(0) - 97;
      const row = 9 - Number(sq[1]);
      await page.touchscreen.tap(
        m.board.x + m.board.width / 2 + (col - 4) * cell,
        m.board.y + m.board.height / 2 + (row - 4.5) * cell
      );
      await page.waitForTimeout(260);
    };
    await page.screenshot({ path: path.join(OUT, `${vp.name}-start.png`) });

    for (const [from, to] of [['h2', 'e2'], ['h9', 'g7'], ['h0', 'g2'], ['i9', 'h9'], ['e2', 'e6']]) {
      await tap(from);
      await tap(to);
    }
    await tap('b9'); // select a black horse to show move hints
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-play.png`) });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xiangqi.save.v1')).game.moves.length);
    assert.equal(saved, 5, `${vp.name}: expected 5 saved moves, got ${saved}`);

    // Menu modal.
    await page.locator('#btn-menu').tap();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-menu.png`) });
    await page.locator('#panel-menu [data-close]').tap();

    // Reload resumes the game; then go offline and reload again.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('board').width > 100);
    assert.equal(await page.evaluate(() => document.getElementById('btn-undo').disabled), false, 'game not restored');
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('board').width > 100);
    const offline = await page.evaluate(async () => ({
      undo: !document.getElementById('btn-undo').disabled,
      cached: (await (await caches.open((await caches.keys())[0])).keys()).length,
      icon: (await fetch('/icons/icon-512.png')).ok,
    }));
    assert.ok(offline.undo && offline.icon, `${vp.name}: offline reload failed ${JSON.stringify(offline)}`);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-offline.png`) });
    m = await metrics();
    assert.ok(m.scrollW <= m.w && m.scrollH <= m.h && m.visible, `${vp.name}: layout broke after reload`);

    assert.deepEqual(problems, [], `${vp.name}: console errors`);
    console.log(`ok ${vp.name} ${vp.width}x${vp.height} board ${Math.round(m.board.width)}x${Math.round(m.board.height)} cached ${offline.cached} files, offline reload ok`);
    await context.close();
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
