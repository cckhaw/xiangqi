/*
 * Xiangqi (象棋) rules engine.
 *
 * No DOM access: this file runs unchanged in the browser (as window.Xiangqi)
 * and in Node (module.exports) so the rules can be tested from the CLI.
 *
 * Board layout: 10 ranks x 9 files, index = row * 9 + col.
 *   row 0 = Black's back rank (top), row 9 = Red's back rank (bottom).
 * A piece is a two-character string: colour ('r' | 'b') + type:
 *   K General, A Advisor, E Elephant, H Horse, R Chariot, C Cannon, P Soldier.
 */
(function (root) {
  'use strict';

  const ROWS = 10;
  const COLS = 9;
  const RED = 'r';
  const BLACK = 'b';

  const START_FEN = 'rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR r';

  const ORTHOGONAL = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  // Accept both the WXF letters (n = horse, b = elephant) and the mnemonic
  // ones used in this file (h, e).
  const FEN_TYPES = { k: 'K', a: 'A', e: 'E', b: 'E', h: 'H', n: 'H', r: 'R', c: 'C', p: 'P' };

  const idx = (r, c) => r * COLS + c;
  const rowOf = (i) => Math.floor(i / COLS);
  const colOf = (i) => i % COLS;
  const onBoard = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const other = (color) => (color === RED ? BLACK : RED);

  const inPalace = (color, r, c) =>
    c >= 3 && c <= 5 && (color === RED ? r >= 7 && r <= 9 : r >= 0 && r <= 2);

  // True once a square is on the far side of the river for `color`.
  const crossedRiver = (color, r) => (color === RED ? r <= 4 : r >= 5);

  function parseFEN(fen) {
    const [placement, side = 'r'] = fen.trim().split(/\s+/);
    const ranks = placement.split('/');
    if (ranks.length !== ROWS) throw new Error('FEN must have 10 ranks');
    const board = new Array(ROWS * COLS).fill(null);
    ranks.forEach((rank, r) => {
      let c = 0;
      for (const ch of rank) {
        if (ch >= '1' && ch <= '9') {
          c += Number(ch);
        } else {
          const type = FEN_TYPES[ch.toLowerCase()];
          if (!type || c >= COLS) throw new Error('Bad FEN rank: ' + rank);
          board[idx(r, c)] = (ch === ch.toUpperCase() ? RED : BLACK) + type;
          c += 1;
        }
      }
      if (c !== COLS) throw new Error('Bad FEN rank: ' + rank);
    });
    return { board, turn: side === 'b' ? BLACK : RED };
  }

  /**
   * Destinations a piece could reach ignoring whether its own General is left
   * in check. Capturing a friendly piece is never included.
   */
  function pseudoMoves(board, from) {
    const piece = board[from];
    if (!piece) return [];
    const color = piece[0];
    const r = rowOf(from);
    const c = colOf(from);
    const out = [];

    const add = (rr, cc) => {
      if (!onBoard(rr, cc)) return;
      const target = board[idx(rr, cc)];
      if (!target || target[0] !== color) out.push(idx(rr, cc));
    };

    switch (piece[1]) {
      case 'K':
        for (const [dr, dc] of ORTHOGONAL) {
          if (inPalace(color, r + dr, c + dc)) add(r + dr, c + dc);
        }
        break;

      case 'A':
        for (const [dr, dc] of DIAGONAL) {
          if (inPalace(color, r + dr, c + dc)) add(r + dr, c + dc);
        }
        break;

      case 'E':
        for (const [dr, dc] of DIAGONAL) {
          const rr = r + 2 * dr;
          const cc = c + 2 * dc;
          if (!onBoard(rr, cc) || crossedRiver(color, rr)) continue;
          if (board[idx(r + dr, c + dc)]) continue; // blocked elephant's eye
          add(rr, cc);
        }
        break;

      case 'H':
        for (const [dr, dc] of ORTHOGONAL) {
          if (!onBoard(r + dr, c + dc) || board[idx(r + dr, c + dc)]) continue; // hobbled leg
          if (dr !== 0) {
            add(r + 2 * dr, c - 1);
            add(r + 2 * dr, c + 1);
          } else {
            add(r - 1, c + 2 * dc);
            add(r + 1, c + 2 * dc);
          }
        }
        break;

      case 'R':
        for (const [dr, dc] of ORTHOGONAL) {
          let rr = r + dr;
          let cc = c + dc;
          while (onBoard(rr, cc)) {
            const target = board[idx(rr, cc)];
            if (target) {
              if (target[0] !== color) out.push(idx(rr, cc));
              break;
            }
            out.push(idx(rr, cc));
            rr += dr;
            cc += dc;
          }
        }
        break;

      case 'C':
        for (const [dr, dc] of ORTHOGONAL) {
          let rr = r + dr;
          let cc = c + dc;
          // Quiet moves up to the first piece (the screen)...
          while (onBoard(rr, cc) && !board[idx(rr, cc)]) {
            out.push(idx(rr, cc));
            rr += dr;
            cc += dc;
          }
          // ...then the first piece beyond the screen can be captured.
          rr += dr;
          cc += dc;
          while (onBoard(rr, cc)) {
            const target = board[idx(rr, cc)];
            if (target) {
              if (target[0] !== color) out.push(idx(rr, cc));
              break;
            }
            rr += dr;
            cc += dc;
          }
        }
        break;

      case 'P': {
        const forward = color === RED ? -1 : 1;
        add(r + forward, c);
        if (crossedRiver(color, r)) {
          add(r, c - 1);
          add(r, c + 1);
        }
        break;
      }

      default:
        break;
    }
    return out;
  }

  function findGeneral(board, color) {
    return board.indexOf(color + 'K');
  }

  /** True when the two Generals share a file with nothing between them. */
  function generalsFacing(board) {
    const red = findGeneral(board, RED);
    const black = findGeneral(board, BLACK);
    if (red < 0 || black < 0 || colOf(red) !== colOf(black)) return false;
    for (let i = black + COLS; i < red; i += COLS) {
      if (board[i]) return false;
    }
    return true;
  }

  /** Is `color`'s General attacked (including by the Flying General rule)? */
  function inCheck(board, color) {
    const general = findGeneral(board, color);
    if (general < 0) return true;
    if (generalsFacing(board)) return true;
    const enemy = other(color);
    for (let i = 0; i < board.length; i++) {
      const piece = board[i];
      if (piece && piece[0] === enemy && piece[1] !== 'K' && pseudoMoves(board, i).includes(general)) {
        return true;
      }
    }
    return false;
  }

  /** Legal destinations for the piece on `from`. */
  function legalMoves(board, from) {
    const piece = board[from];
    if (!piece) return [];
    const color = piece[0];
    return pseudoMoves(board, from).filter((to) => {
      const captured = board[to];
      board[to] = piece;
      board[from] = null;
      const safe = !inCheck(board, color);
      board[from] = piece;
      board[to] = captured;
      return safe;
    });
  }

  function allLegalMoves(board, color) {
    const moves = [];
    for (let from = 0; from < board.length; from++) {
      if (board[from] && board[from][0] === color) {
        for (const to of legalMoves(board, from)) moves.push({ from, to });
      }
    }
    return moves;
  }

  function hasLegalMove(board, color) {
    for (let from = 0; from < board.length; from++) {
      if (board[from] && board[from][0] === color && legalMoves(board, from).length) return true;
    }
    return false;
  }

  class Game {
    constructor(fen = START_FEN) {
      this.load(fen);
    }

    /** Reset to a position given as FEN (defaults to the opening array). */
    load(fen = START_FEN) {
      const { board, turn } = parseFEN(fen);
      this.startFEN = fen;
      this.startBoard = board.slice();
      this.startTurn = turn;
      this.board = board;
      this.turn = turn;
      this.history = [];
      this._evaluate();
      return this;
    }

    reset() {
      return this.load(START_FEN);
    }

    pieceAt(i) {
      return this.board[i];
    }

    get isOver() {
      return this.status !== 'playing';
    }

    inCheck(color = this.turn) {
      return inCheck(this.board, color);
    }

    legalMovesFrom(from) {
      const piece = this.board[from];
      if (this.isOver || !piece || piece[0] !== this.turn) return [];
      return legalMoves(this.board, from);
    }

    allLegalMoves(color = this.turn) {
      return allLegalMoves(this.board, color);
    }

    /**
     * Play a move for the side to move. Returns the history record, or null
     * if the move is illegal (nothing changes in that case).
     */
    move(from, to) {
      if (!this.legalMovesFrom(from).includes(to)) return null;
      const piece = this.board[from];
      const captured = this.board[to];
      this.board[to] = piece;
      this.board[from] = null;
      this.turn = other(this.turn);
      this._evaluate();
      const record = {
        from,
        to,
        piece,
        captured,
        check: this.check,
        status: this.status,
      };
      this.history.push(record);
      return record;
    }

    /** Take back the last move. Returns its record, or null if none. */
    undo() {
      const record = this.history.pop();
      if (!record) return null;
      this.board[record.from] = record.piece;
      this.board[record.to] = record.captured;
      this.turn = record.piece[0];
      this._evaluate();
      return record;
    }

    /** Board as it stood after the first `n` moves (0 = starting position). */
    boardAt(n) {
      const board = this.startBoard.slice();
      const count = Math.max(0, Math.min(n, this.history.length));
      for (let i = 0; i < count; i++) {
        const { from, to, piece } = this.history[i];
        board[to] = piece;
        board[from] = null;
      }
      return board;
    }

    toJSON() {
      return {
        fen: this.startFEN,
        moves: this.history.map((m) => [m.from, m.to]),
      };
    }

    /** Rebuild a game by replaying saved moves; throws if any is illegal. */
    static fromJSON(data) {
      const game = new Game((data && data.fen) || START_FEN);
      for (const [from, to] of (data && data.moves) || []) {
        if (!game.move(from, to)) throw new Error('Illegal move in saved game');
      }
      return game;
    }

    _evaluate() {
      this.check = inCheck(this.board, this.turn);
      if (hasLegalMove(this.board, this.turn)) {
        this.status = 'playing';
        this.winner = null;
      } else {
        // No legal move loses in Xiangqi, whether mated or stalemated.
        this.status = this.check ? 'checkmate' : 'stalemate';
        this.winner = other(this.turn);
      }
    }
  }

  const api = {
    ROWS,
    COLS,
    RED,
    BLACK,
    START_FEN,
    Game,
    idx,
    rowOf,
    colOf,
    other,
    parseFEN,
    pseudoMoves,
    legalMoves,
    allLegalMoves,
    inCheck,
    generalsFacing,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Xiangqi = api;
})(typeof self !== 'undefined' ? self : this);
