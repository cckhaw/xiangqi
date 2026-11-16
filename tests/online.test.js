'use strict';
// Network-layer and room-protocol tests. The real client code (net.js,
// online.js) talks over real WebSockets to the local test broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../game.js');
const Net = require('../net.js');
const { Room, validState } = require('../online.js');
const { startWebSocketBroker } = require('./helpers/mini-broker.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(15);
  }
  assert.fail('timed out waiting for ' + what);
}

const sq = (name) => X.idx(9 - Number(name[1]), name.charCodeAt(0) - 97);

async function pair(t, opts = {}) {
  const srv = await startWebSocketBroker();
  const rooms = [];
  t.after(async () => {
    for (const r of rooms) await r.leave();
    await srv.close();
  });
  const make = (role, code, extra = {}) => {
    const events = [];
    const room = new Room({
      code, role, brokers: [srv.url], WebSocketImpl: WebSocket,
      onChange: (c) => events.push(c), ...extra,
    });
    room.events = events;
    rooms.push(room);
    return room;
  };
  return { srv, make, rooms };
}

test('codes: unambiguous alphabet, correct length, normalisation', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const code = Net.genCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.equal(Net.normCode(Net.prettyCode(code).toLowerCase()), code);
    seen.add(code);
  }
  assert.ok(seen.size > 295);
  for (const bad of ['', 'ABC', 'ABCDEFG', 'ABCDE0', 'ABCDEI', 'ABC DE!', null]) assert.equal(Net.normCode(bad), null);
  assert.equal(Net.normCode(' k7m-4pq '), 'K7M4PQ');
});

test('crypto: round trip, wrong code and tampering are rejected, topic hides the code', async () => {
  const a = await Net.deriveRoom('K7M4PQ');
  const b = await Net.deriveRoom('K7M4PR');
  assert.match(a.topic, /^xqpwa\/1\/[0-9a-f]{20}$/);
  assert.ok(!a.topic.toLowerCase().includes('k7m4pq'));
  assert.notEqual(a.topic, b.topic);
  assert.equal((await Net.deriveRoom('K7M4PQ')).topic, a.topic);
  const sealed = await Net.seal(a.key, { hello: '棋', n: 5 });
  assert.ok(!sealed.includes('hello'));
  assert.deepEqual(await Net.open(a.key, sealed), { hello: '棋', n: 5 });
  assert.notEqual(await Net.seal(a.key, { x: 1 }), await Net.seal(a.key, { x: 1 })); // fresh IV
  assert.equal(await Net.open(b.key, sealed), null);
  const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
  assert.equal(await Net.open(a.key, flipped), null);
  assert.equal(await Net.open(a.key, 'not base64 !!'), null);
  assert.equal(await Net.open(a.key, ''), null);
});

test('mqtt codec: known byte vectors and fragmented / coalesced input', () => {
  const { mqtt } = Net;
  assert.deepEqual([...mqtt.pingreq()], [0xc0, 0]);
  assert.deepEqual([...mqtt.disconnect()], [0xe0, 0]);
  assert.deepEqual([...mqtt.subscribe(1, 'a/#')], [0x82, 8, 0, 1, 0, 3, 0x61, 0x2f, 0x23, 0]);
  assert.deepEqual([...mqtt.publish('t', 'hi', true)], [0x31, 5, 0, 1, 0x74, 0x68, 0x69]);
  const c = mqtt.connect({ clientId: 'c1', keepalive: 30 });
  assert.deepEqual([...c.subarray(0, 12)], [0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 2, 0, 30]);
  const withWill = mqtt.connect({ clientId: 'c1', will: { topic: 'w', payload: 'x' } });
  assert.equal(withWill[9], 0x02 | 0x04 | 0x20);

  const big = 'x'.repeat(300); // multi-byte remaining length
  const p1 = mqtt.publish('room/h', big, true);
  const p2 = mqtt.publish('room/g', 'two', false);
  const joined = new Uint8Array([...p1, ...p2]);
  const d = mqtt.decoder();
  let got = [];
  for (let i = 0; i < joined.length; i += 7) got = got.concat(d.feed(joined.subarray(i, i + 7)));
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].topic, got[0].text.length, got[0].retain], ['room/h', 300, true]);
  assert.deepEqual([got[1].topic, got[1].text, got[1].retain], ['room/g', 'two', false]);
  assert.deepEqual(mqtt.decoder().feed(Uint8Array.from([0x20, 2, 0, 0]))[0], { type: 2, flags: 0, code: 0 });
});

test('link: delivers only decrypted room traffic, replays retained, survives reconnects', async (t) => {
  const srv = await startWebSocketBroker();
  t.after(() => srv.close());
  const got = [];
  const a = new Net.Link({ code: 'ABCDEF', clientId: 'a', brokers: [srv.url], WebSocketImpl: WebSocket, onMessage: (s, o) => got.push(['a', s, o]) });
  await a.start();
  await until(() => a.status === 'online', 'a online');
  await a.publish('x', { v: 1 });
  // A stranger without the code publishes junk into the same broker topic space.
  const stranger = new Net.Link({ code: 'ZZZZZZ', clientId: 's', brokers: [srv.url], WebSocketImpl: WebSocket });
  await stranger.start();
  await until(() => stranger.status === 'online', 'stranger online');
  await stranger.publish('x', { v: 'evil' });
  await wait(100);
  assert.deepEqual(got.map((g) => g[2]), [{ v: 1 }]);

  const late = [];
  const b = new Net.Link({ code: 'ABCDEF', clientId: 'b', brokers: [srv.url], WebSocketImpl: WebSocket, onMessage: (s, o, r) => late.push([s, o, r]) });
  await b.start();
  await until(() => late.length === 1, 'retained delivery');
  assert.deepEqual(late[0], ['x', { v: 1 }, true]);

  srv.broker.dropAll(); // network blip: both reconnect and replay what they last published
  await until(() => a.status === 'offline' || a.status === 'online', 'drop noticed');
  await until(() => a.status === 'online' && b.status === 'online', 'reconnected', 6000);
  await a.publish('x', { v: 2 });
  await until(() => late.some((l) => l[1].v === 2), 'message after reconnect');
  for (const l of [a, b, stranger]) l.close();
});

test('room: create, join, play moves both ways, colours and clocks sync', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  assert.equal(host.phase, 'waiting');
  const hostColor = host.myColor;
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => host.phase === 'playing' && guest.phase === 'playing', 'both playing');
  assert.equal(guest.myColor, hostColor === 'r' ? 'b' : 'r');
  // Presence published before the seat existed must still be applied afterwards.
  await until(() => host.peerOnline === true && guest.peerOnline === true, 'both see each other online');
  assert.notEqual(host.id, guest.id);

  const red = host.myColor === 'r' ? host : guest;
  const black = red === host ? guest : host;
  assert.equal(black.move(sq('a6'), sq('a5')), null, 'not black\'s turn');
  assert.equal(red.move(sq('a0'), sq('a5')), null, 'illegal move');
  assert.ok(red.move(sq('h2'), sq('e2'), { r: 4000, b: 0 }));
  await until(() => black.game.history.length === 1, 'black sees red move');
  assert.equal(black.state.c.r, 4000);
  assert.equal(black.events.at(-1).kind, 'move');
  assert.equal(red.move(sq('e2'), sq('e6')), null, 'red cannot move twice');
  assert.ok(black.move(sq('h7'), sq('e7')));
  await until(() => red.game.history.length === 2, 'red sees black move');
  assert.equal(red.game.turn, 'r');
  assert.deepEqual(red.game.board, black.game.board);
});

test('room: full, missing and bad rooms', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => guest.phase === 'playing', 'seated');
  const third = make('guest', 'ABCDEF');
  await third.start();
  await until(() => third.phase === 'full', 'third player turned away');
  assert.equal(host.state.gid, guest.id);

  const nobody = make('guest', 'QQQQQQ');
  nobody.link = null;
  await nobody.start();
  assert.equal(nobody.phase, 'checking');
  await until(() => nobody.phase === 'missing', 'no such game', 12000);
});

test('room: resume after reload, including moves made while away', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => host.phase === 'playing' && guest.phase === 'playing', 'playing');
  const red = host.myColor === 'r' ? host : guest;
  const black = red === host ? guest : host;
  red.move(sq('h2'), sq('e2'));
  await until(() => black.game.history.length === 1, 'sync 1');

  // Red "closes the app"; black replies while red is away; red reopens from saved state.
  const saved = JSON.parse(JSON.stringify(red.snapshot()));
  await red.leave();
  await until(() => black.peerOnline === false, 'opponent sees them leave');
  assert.ok(black.move(sq('h7'), sq('e7')));
  const back = make(saved.role, 'ABCDEF', { id: saved.id, saved: saved.state });
  await back.start();
  await until(() => back.game.history.length === 2, 'caught up after reconnect');
  await until(() => black.peerOnline === true, 'opponent sees them return');
  assert.equal(back.myColor, 'r');
  assert.equal(back.game.turn, 'r');
  assert.ok(back.move(sq('b2'), sq('c2')), 'resumed player can move');

  // Reopening with NO saved state (cleared storage) still recovers the same seat.
  if (saved.role === 'guest') {
    await back.leave();
    const fresh = make('guest', 'ABCDEF', { id: saved.id });
    await fresh.start();
    await until(() => fresh.phase === 'playing', 'seat recovered from relay');
    assert.ok(fresh.game.history.length >= 2);
  }
});

test('room: takeback request accepted and declined', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => host.phase === 'playing' && guest.phase === 'playing', 'playing');
  const red = host.myColor === 'r' ? host : guest;
  const black = red === host ? guest : host;
  assert.equal(red.undoTarget(), -1);
  red.move(sq('h2'), sq('e2'));
  await until(() => black.game.history.length === 1, 'sync');
  assert.equal(black.undoTarget(), -1, 'black has not moved yet');
  assert.equal(red.undoTarget(), 0);
  assert.ok(red.request('undo'));
  await until(() => black.state.req && black.state.req.by === 'r', 'black sees request');
  assert.equal(black.respond(false), true);
  await until(() => red.state.req && red.state.req.declined, 'red sees decline');
  assert.equal(red.game.history.length, 1);

  assert.ok(red.request('undo'));
  await until(() => black.state.req && !black.state.req.declined, 'second request');
  assert.equal(red.respond(true), false, 'cannot answer own request');
  assert.ok(black.respond(true));
  await until(() => red.game.history.length === 0 && black.game.history.length === 0, 'both rolled back');
  assert.equal(red.game.turn, 'r');
  assert.equal(black.events.at(-1).kind, 'undo');

  // A move clears any stale request, and takeback after the opponent replied rewinds two plies.
  red.move(sq('h2'), sq('e2'));
  await until(() => black.game.history.length === 1, 'sync again');
  black.move(sq('h7'), sq('e7'));
  await until(() => red.game.history.length === 2, 'sync again 2');
  assert.equal(red.undoTarget(), 0);
  assert.equal(black.undoTarget(), 1);
});

test('room: resignation and rematch swap colours', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => host.phase === 'playing' && guest.phase === 'playing', 'playing');
  const firstHostColor = host.myColor;
  assert.equal(host.request('new'), false, 'no rematch while the game is live');
  assert.ok(guest.resign());
  await until(() => host.game.isOver, 'host sees resignation');
  assert.equal(host.game.status, 'resigned');
  assert.equal(host.game.winner, host.myColor);
  assert.equal(host.events.at(-1).kind, 'resign');
  assert.equal(host.undoTarget(), -1);
  assert.equal(host.resign(), false);

  assert.ok(host.request('new'));
  await until(() => guest.state.req && guest.state.req.k === 'new', 'rematch offered');
  assert.ok(guest.respond(true));
  await until(() => host.state.g === 2 && guest.state.g === 2, 'new game');
  assert.equal(host.game.history.length, 0);
  assert.equal(host.game.isOver, false);
  assert.notEqual(host.myColor, firstHostColor);
  assert.notEqual(guest.myColor, host.myColor);
  assert.equal(host.events.at(-1).kind, 'newgame');
});

test('room: rejects forged, illegal and foreign states', async (t) => {
  const { make } = await pair(t);
  const host = make('host', 'ABCDEF');
  await host.start();
  const guest = make('guest', 'ABCDEF');
  await guest.start();
  await until(() => host.phase === 'playing' && guest.phase === 'playing', 'playing');
  const before = JSON.stringify(host.state);
  const st = { ...guest.state, s: guest.state.s + 5, m: [0, 1, 2] }; // illegal history
  assert.equal(validState(st), true);
  host._onState(st, 'g');
  host._onState({ ...guest.state, s: 99, gid: 'someoneelse' }, 'g');
  host._onState({ ...guest.state, s: 99 }, 'h'); // wrong topic for a host
  host._onState({ s: 'x' }, 'g');
  host._onJoin('intruder'); // seat already taken
  assert.equal(JSON.stringify(host.state), before);
  assert.equal(validState({ ...guest.state, m: [9000] }), false);
  assert.equal(validState({ ...guest.state, hc: 'x' }), false);
  assert.equal(validState(null), false);
});
