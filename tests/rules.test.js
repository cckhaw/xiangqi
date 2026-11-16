'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../game.js');

const { Game, idx } = X;

// Squares are written file-letter + rank as in WXF diagrams: files a-i from
// the left, ranks 0-9 from Red's back rank (bottom) to Black's (top).
const sq = (name) => idx(9 - Number(name[1]), name.charCodeAt(0) - 97);
const name = (i) => String.fromCharCode(97 + X.colOf(i)) + (9 - X.rowOf(i));
const moves = (game, from) => game.legalMovesFrom(sq(from)).map(name).sort();

function perft(board, color, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const { from, to } of X.allLegalMoves(board, color)) {
    const piece = board[from];
    const captured = board[to];
    board[to] = piece;
    board[from] = null;
    nodes += perft(board, X.other(color), depth - 1);
    board[from] = piece;
    board[to] = captured;
  }
  return nodes;
}

test('opening position: move counts match published perft values', () => {
  const game = new Game();
  assert.equal(game.turn, 'r');
  assert.equal(game.allLegalMoves().length, 44);
  assert.equal(perft(game.board.slice(), 'r', 2), 1920);
  assert.equal(perft(game.board.slice(), 'r', 3), 79666);
});

test('general: one orthogonal step, confined to the palace', () => {
  const game = new Game('3k5/9/9/9/9/9/9/9/9/5K3 r');
  assert.deepEqual(moves(game, 'f0'), ['e0', 'f1']);
  const centre = new Game('3k5/9/9/9/9/9/9/9/4K4/9 r');
  assert.deepEqual(moves(centre, 'e1'), ['e0', 'e2', 'f1']); // d1 faces the black general
});

test('flying general: generals may not face each other on an open file', () => {
  // Red general cannot step onto the open d-file.
  const game = new Game('3k5/9/9/9/9/9/9/9/9/4K4 r');
  assert.deepEqual(moves(game, 'e0'), ['e1', 'f0']);
  // A lone piece between the generals is pinned to the file.
  const pinned = new Game('4k4/9/9/9/9/4R4/9/9/9/4K4 r');
  assert.ok(moves(pinned, 'e4').every((m) => m[0] === 'e'));
  assert.ok(moves(pinned, 'e4').includes('e9')); // may capture along the file
  assert.equal(X.generalsFacing(X.parseFEN('4k4/9/9/9/9/9/9/9/9/4K4 r').board), true);
  assert.equal(X.generalsFacing(pinned.board), false);
});

test('advisor: one diagonal step, confined to the palace', () => {
  const game = new Game('4k4/9/9/9/9/9/9/9/4A4/3K5 r');
  assert.deepEqual(moves(game, 'e1'), ['d2', 'f0', 'f2']); // d0 holds the general
  const corner = new Game('4k4/9/9/9/9/9/9/5A3/9/3K5 r');
  assert.deepEqual(moves(corner, 'f2'), ['e1']);
});

test('elephant: two diagonal steps, never across the river', () => {
  const game = new Game('3k5/9/9/9/9/2E6/9/9/9/4K4 r');
  assert.deepEqual(moves(game, 'c4'), ['a2', 'e2']); // a6/e6 are across the river
  const black = new Game('3k5/9/9/9/2e6/9/9/9/9/4K4 b');
  assert.deepEqual(moves(black, 'c5'), ['a7', 'e7']);
});

test("elephant: blocked when the elephant's eye is occupied", () => {
  const game = new Game('3k5/9/9/9/9/9/9/9/3p5/2E1K4 r');
  assert.deepEqual(moves(game, 'c0'), ['a2']); // d1 is the eye on the way to e2
  const blockedBoth = new Game('3k5/9/9/9/9/9/9/9/1P1p5/2E1K4 r');
  assert.deepEqual(moves(blockedBoth, 'c0'), []);
});

test('horse: L-shaped move, eight destinations when free', () => {
  const game = new Game('3k5/9/9/9/9/4H4/9/9/9/5K3 r');
  assert.deepEqual(moves(game, 'e4'), ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5']);
});

test("horse: blocked when the horse's leg is hobbled", () => {
  // Piece directly above the horse removes both upward jumps only.
  const game = new Game('3k5/9/9/9/4p4/4H4/9/9/9/5K3 r');
  assert.deepEqual(moves(game, 'e4'), ['c3', 'c5', 'd2', 'f2', 'g3', 'g5']);
  // A friendly piece hobbles just the same.
  const friendly = new Game('3k5/9/9/9/9/3PH4/9/9/9/5K3 r');
  assert.deepEqual(moves(friendly, 'e4'), ['d2', 'd6', 'f2', 'f6', 'g3', 'g5']);
  // The opening horse cannot jump towards the centre file past its elephant.
  assert.deepEqual(moves(new Game(), 'b0'), ['a2', 'c2']);
});

test('chariot: slides orthogonally until blocked', () => {
  const game = new Game('3k5/9/9/9/9/2p1R1P2/9/9/9/5K3 r');
  const got = moves(game, 'e4');
  assert.ok(got.includes('c4')); // captures the enemy soldier
  assert.ok(!got.includes('b4')); // cannot pass it
  assert.ok(got.includes('f4') && !got.includes('g4')); // stops before own soldier
  assert.ok(got.includes('e9') && got.includes('e0'));
});

test('cannon: moves like a chariot but captures only over exactly one screen', () => {
  const game = new Game('4k4/9/4p4/9/4p4/9/9/4C4/9/3K5 r');
  const got = moves(game, 'e2');
  assert.ok(got.includes('e3') && got.includes('e4')); // quiet moves up to the screen
  assert.ok(!got.includes('e5')); // cannot capture the screen itself
  assert.ok(!got.includes('e6')); // cannot land on an empty point beyond it
  assert.ok(got.includes('e7')); // captures the first piece beyond the screen
  assert.ok(!got.includes('e9')); // two screens: no capture
  assert.ok(got.includes('a2') && got.includes('i2') && got.includes('e0'));
});

test('cannon: no capture without a screen, and none over a friendly target', () => {
  const noScreen = new Game('3k5/9/9/9/4p4/9/9/4C4/9/3K5 r');
  assert.ok(!moves(noScreen, 'e2').includes('e5'));
  const ownTarget = new Game('3k5/9/4P4/9/4p4/9/9/4C4/9/3K5 r');
  assert.ok(!moves(ownTarget, 'e2').includes('e7'));
  // From the opening array each cannon can take a horse over the enemy cannon.
  assert.ok(moves(new Game(), 'b2').includes('b9'));
});

test('soldier: forward only before the river, sideways too after crossing', () => {
  const before = new Game('3k5/9/9/9/9/4P4/9/9/9/5K3 r');
  assert.deepEqual(moves(before, 'e4'), ['e5']);
  const after = new Game('3k5/9/9/9/4P4/9/9/9/9/5K3 r');
  assert.deepEqual(moves(after, 'e5'), ['d5', 'e6', 'f5']);
  const lastRank = new Game('5k3/9/9/9/9/9/9/9/9/3K5 r');
  lastRank.board[sq('a9')] = 'rP';
  assert.deepEqual(moves(lastRank, 'a9'), ['b9']); // never backward
  const black = new Game('3k5/9/9/9/9/4p4/9/9/9/5K3 b');
  assert.deepEqual(moves(black, 'e4'), ['d4', 'e3', 'f4']);
  const blackBefore = new Game('3k5/9/9/9/4p4/9/9/9/9/5K3 b');
  assert.deepEqual(moves(blackBefore, 'e5'), ['e4']);
});

test('check: detected, and only moves that resolve it are legal', () => {
  const game = new Game('4k4/9/9/9/9/9/9/9/4r4/R3K4 r');
  assert.equal(game.check, true);
  assert.equal(game.status, 'playing');
  // Capturing the chariot would leave the generals facing each other, and the
  // red chariot can neither block nor capture, so the general must step aside.
  assert.deepEqual(game.allLegalMoves().map((m) => name(m.from) + name(m.to)), ['e0d0', 'e0f0']);
});

test('a pinned piece may not expose its own general', () => {
  const game = new Game('4k4/9/9/9/4r4/9/9/9/4H4/4K4 r');
  assert.deepEqual(moves(game, 'e1'), []);
});

test('turn enforcement and illegal moves are rejected without side effects', () => {
  const game = new Game();
  assert.equal(game.move(sq('a9'), sq('a8')), null); // black piece on red's turn
  assert.equal(game.move(sq('a0'), sq('a5')), null); // chariot through a soldier
  assert.equal(game.history.length, 0);
  assert.ok(game.move(sq('h2'), sq('e2')));
  assert.equal(game.turn, 'b');
  assert.deepEqual(game.legalMovesFrom(sq('a0')), []);
});

test('checkmate: double chariots on the back ranks', () => {
  const game = new Game('4k4/R8/9/9/9/9/9/9/9/1R1K5 r');
  const record = game.move(sq('b0'), sq('b9'));
  assert.equal(record.check, true);
  assert.equal(game.status, 'checkmate');
  assert.equal(game.winner, 'r');
  assert.deepEqual(game.allLegalMoves(), []);
  assert.equal(game.move(sq('e9'), sq('e8')), null);
});

test('checkmate: double cannons on the central file', () => {
  // The front cannon is the screen for the rear one; if an advisor interposes
  // it becomes the screen for the front cannon instead.
  const game = new Game('3aka3/9/9/9/9/9/4C4/9/4C4/3K5 r');
  assert.equal(game.check, false);
  game.move(sq('e1'), sq('e2'));
  assert.equal(game.check, true);
  assert.equal(game.status, 'checkmate');
  assert.equal(game.winner, 'r');
});

test('a single cannon check can be answered by removing or doubling the screen', () => {
  const game = new Game('3aka3/9/9/9/4P4/9/9/4C4/9/3K5 b');
  assert.equal(game.check, true);
  assert.equal(game.status, 'playing');
  assert.ok(moves(game, 'd9').includes('e8')); // a second screen blocks the cannon
});

test('stalemate: a side with no legal move loses even when not in check', () => {
  // Black: general d9 only. After Re7-e8 it is not in check, but d8 and e9
  // are both covered by the chariot.
  const stale = new Game('3k5/9/4R4/9/9/9/9/9/9/5K3 r');
  stale.move(sq('e7'), sq('e8'));
  assert.equal(stale.check, false);
  assert.equal(stale.status, 'stalemate');
  assert.equal(stale.winner, 'r');
  assert.deepEqual(stale.allLegalMoves(), []);
});

test('undo restores board, turn, captures and status', () => {
  const game = new Game('4k4/R8/9/9/9/9/9/9/9/1R1K5 r');
  const before = game.board.slice();
  game.move(sq('b0'), sq('b9'));
  assert.equal(game.status, 'checkmate');
  game.undo();
  assert.deepEqual(game.board, before);
  assert.equal(game.turn, 'r');
  assert.equal(game.status, 'playing');
  assert.equal(game.undo(), null);

  const capture = new Game();
  capture.move(sq('b2'), sq('b9'));
  assert.equal(capture.history[0].captured, 'bH');
  capture.undo();
  assert.equal(capture.pieceAt(sq('b9')), 'bH');
  assert.equal(capture.pieceAt(sq('b2')), 'rC');
});

test('history: boardAt replays positions and JSON round-trips', () => {
  const game = new Game();
  const line = [['h2', 'e2'], ['h9', 'g7'], ['h0', 'g2'], ['i9', 'h9'], ['e2', 'e6']];
  for (const [from, to] of line) assert.ok(game.move(sq(from), sq(to)), from + to);
  assert.equal(game.check, false);
  assert.deepEqual(game.boardAt(0), new Game().board);
  assert.deepEqual(game.boardAt(line.length), game.board);
  assert.equal(game.boardAt(1)[sq('e2')], 'rC');
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
  assert.deepEqual(copy.board, game.board);
  assert.equal(copy.turn, game.turn);
  assert.throws(() => Game.fromJSON({ moves: [[0, 80]] }));
});

test('resignation ends the game for the other side and survives JSON', () => {
  const game = new Game();
  game.move(sq('h2'), sq('e2'));
  assert.equal(game.resign('x'), false);
  assert.equal(game.resign('b'), true);
  assert.equal(game.status, 'resigned');
  assert.equal(game.winner, 'r');
  assert.equal(game.isOver, true);
  assert.deepEqual(game.legalMovesFrom(sq('a6')), []);
  assert.equal(game.undo(), null);
  assert.equal(game.resign('r'), false); // already over
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
  assert.equal(copy.status, 'resigned');
  assert.equal(copy.winner, 'r');
  assert.equal(new Game().resigned, null);
});
