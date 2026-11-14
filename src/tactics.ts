// Spots tactics created by a move: forks, pins and skewers by the piece that
// just moved, attacks it uncovered, and double checks. Used to put little
// badges on the player's own moves.
//
// The rules are deliberately conservative, so a badge means something:
// - Fork: the piece attacks 2+ enemy pieces that are each the king, worth more
//   than it, or undefended (pawns don't count as targets).
// - Pin: a bishop/rook/queen attacks a piece that has the king, or a more
//   valuable piece it would expose, behind it on the same line. Pinned pawns
//   don't count (rarely worth a badge).
// - Skewer: the same line, but the front piece is the king or worth more than
//   the one behind it (which isn't a pawn), so it has to move and lose it.
// None of those count if the moving piece can simply be taken for free, or if
// the front piece on a pin/skewer line can just capture it.
// - Discovered attack: moving off a line uncovers our bishop/rook/queen onto
//   the enemy king, a piece worth more than it, or an undefended piece (not a
//   pawn). Counts even if the moved piece hangs: the point is what it reveals.
// - Double check: two of our pieces give check at once. It replaces a
//   "discovered" badge whose only uncovered target is the king.
// - Mate threat: the move sets up a mate in one (if the opponent ignored it)
//   that wasn't there before. Not when the move gives check.
// - Free piece: it captures a piece (not a pawn) and comes out 2+ pawns ahead,
//   counting the whole run of captures it ends, anywhere on the board (so the
//   last capture of a trade isn't "free"), and what can still be won back.
// - Trapped piece: it attacks a knight/bishop/rook/queen that's under threat
//   and has no square to go where it isn't (or that wins as much back).
// - Battery: it lines up with another of our bishops/rooks/queens on the same
//   line (one behind the other), aimed at an enemy piece other than a pawn.
// - Sacrifice (see sacrificeCandidate): it gives up 2+ pawns' worth of
//   material; the caller confirms it's sound (the engine, or a puzzle solution).

import { Chess, type Move } from "chess.js";

export type Tactic =
  | "sacrifice"
  | "double-check"
  | "mate-threat"
  | "fork"
  | "discovered"
  | "trapped"
  | "skewer"
  | "pin"
  | "free-piece"
  | "battery";

/** Most striking first: the order badges are shown in, and which three win when there are more. */
export const TACTIC_ORDER: Tactic[] = ["sacrifice", "double-check", "mate-threat", "fork", "discovered", "trapped", "skewer", "pin", "free-piece", "battery"];

/**
 * One tactic and who's involved, as piece codes ("wq"): `by` makes it (the
 * moved piece, the uncovered slider, or both checkers) and `targets` are what
 * it hits, in order (a pin/skewer lists the front piece, then the one behind).
 */
export interface TacticDetail {
  kind: Tactic;
  by: string[];
  targets: string[];
  /** Arrows to draw for it, as [from, to] squares: who attacks what (a pin/skewer runs through to the piece behind). */
  arrows: [string, string][];
}

type Color = "w" | "b";
interface Piece {
  type: string;
  color: Color;
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const LINES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

type Grid = (Piece | null)[][]; // grid[file][rank], 0-based

function toGrid(chess: Chess): Grid {
  const grid: Grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  chess.board().forEach((row, i) =>
    row.forEach((p, f) => {
      if (p) grid[f][7 - i] = { type: p.type, color: p.color };
    }),
  );
  return grid;
}

const inside = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
const toXY = (sq: string): [number, number] => [sq.charCodeAt(0) - 97, Number(sq[1]) - 1];

function slideDirs(type: string): number[][] {
  if (type === "b") return DIAGONALS;
  if (type === "r") return LINES;
  if (type === "q") return [...DIAGONALS, ...LINES];
  return [];
}

/** Squares attacked by the piece on (f, r). */
function attacks(grid: Grid, f: number, r: number): [number, number][] {
  const p = grid[f][r]!;
  const out: [number, number][] = [];
  if (p.type === "p") {
    const dir = p.color === "w" ? 1 : -1;
    for (const df of [-1, 1]) if (inside(f + df, r + dir)) out.push([f + df, r + dir]);
  } else if (p.type === "n" || p.type === "k") {
    for (const [df, dr] of p.type === "n" ? KNIGHT : KING) if (inside(f + df, r + dr)) out.push([f + df, r + dr]);
  } else {
    for (const [df, dr] of slideDirs(p.type)) {
      let x = f + df;
      let y = r + dr;
      while (inside(x, y)) {
        out.push([x, y]);
        if (grid[x][y]) break;
        x += df;
        y += dr;
      }
    }
  }
  return out;
}

/** `color`'s pieces attacking (f, r). */
function attackingPieces(grid: Grid, f: number, r: number, color: Color): Piece[] {
  return attackingSquares(grid, f, r, color).map(([x, y]) => grid[x][y]!);
}

/** Squares of `color`'s pieces attacking (f, r). */
function attackingSquares(grid: Grid, f: number, r: number, color: Color): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      const p = grid[x][y];
      if (p && p.color === color && attacks(grid, x, y).some(([a, b]) => a === f && b === r)) out.push([x, y]);
    }
  }
  return out;
}

const sqName = (x: number, y: number) => String.fromCharCode(97 + x) + (y + 1);

/** Values of `color`'s pieces attacking (f, r). */
function attackersOf(grid: Grid, f: number, r: number, color: Color): number[] {
  return attackingPieces(grid, f, r, color).map((p) => VALUE[p.type]);
}

const code = (p: Piece) => p.color + p.type;

/** The piece on (f, r) can be won by its opponent: attacked and undefended, or attacked by something cheaper. */
function hanging(grid: Grid, f: number, r: number): boolean {
  const p = grid[f][r]!;
  const enemy: Color = p.color === "w" ? "b" : "w";
  const attackers = attackersOf(grid, f, r, enemy);
  if (!attackers.length) return false;
  if (!attackersOf(grid, f, r, p.color).length) return true;
  return Math.min(...attackers) < VALUE[p.type];
}

/** A move of the player's that set up tactics, for the Tactical info list. */
export interface TacticLogEntry {
  /** Moves played up to and including this one. */
  ply: number;
  /** e.g. "21… Qd1+" */
  label: string;
  details: TacticDetail[];
  /** The opponent's move (listed only with that setting on). */
  enemy?: boolean;
}

/** "21… Qd1+": the move number (from the position before it) and the move. */
export function moveLabel(move: Move): string {
  const n = move.before.split(" ")[5] ?? "1";
  return `${n}${move.color === "w" ? "." : "…"} ${move.san}`;
}

/** Tactics created by `move`, which has just been played on `chess` (most striking first, at most three). */
export function tacticsOf(chess: Chess, move: Move, before: Move[] = []): Tactic[] {
  return [...new Set(tacticDetails(chess, move, before).map((d) => d.kind))];
}

/**
 * The tactics created by `move` with the pieces involved (see TacticDetail),
 * most striking first. `before`: the moves played before it, oldest first (to
 * tell a trade from winning a piece); optional.
 */
export function tacticDetails(chess: Chess, move: Move, before: Move[] = []): TacticDetail[] {
  const grid = toGrid(chess);
  const [f, r] = toXY(move.to);
  const piece = grid[f][r];
  if (!piece) return [];
  const us = piece.color;
  const them: Color = us === "w" ? "b" : "w";
  const found: TacticDetail[] = [];
  const has = (kind: Tactic) => found.some((d) => d.kind === kind);

  // Double check
  const enemyKing = findKing(grid, them);
  if (enemyKing) {
    const checkers = attackingSquares(grid, enemyKing[0], enemyKing[1], us);
    if (checkers.length >= 2) {
      const king = sqName(enemyKing[0], enemyKing[1]);
      found.push({
        kind: "double-check",
        by: checkers.map(([x, y]) => code(grid[x][y]!)),
        targets: [them + "k"],
        arrows: checkers.map(([x, y]) => [sqName(x, y), king]),
      });
    }
  }

  // Discovered attacks: lines from our sliders that now run through the square we left.
  const [ff, fr] = toXY(move.from);
  let uncoveredOther = false;
  // Castling moves the rook across the king's old square; that isn't a discovery.
  const castled = move.isKingsideCastle() || move.isQueensideCastle();
  for (let x = 0; x < 8 && !castled; x++) {
    for (let y = 0; y < 8; y++) {
      const s = grid[x][y];
      if (!s || s.color !== us || (x === f && y === r)) continue;
      const hits: string[] = [];
      const hitSquares: string[] = [];
      for (const [df, dr] of slideDirs(s.type)) {
        let tx = x + df;
        let ty = y + dr;
        let passedFrom = false;
        while (inside(tx, ty) && !grid[tx][ty]) {
          if (tx === ff && ty === fr) passedFrom = true;
          tx += df;
          ty += dr;
        }
        if (!passedFrom || !inside(tx, ty)) continue;
        const t = grid[tx][ty]!;
        if (t.color !== them || t.type === "p") continue;
        if (t.type === "k") {
          hits.push(code(t));
          hitSquares.push(sqName(tx, ty));
        } else if (VALUE[t.type] > VALUE[s.type] || !attackersOf(grid, tx, ty, them).length) {
          hits.push(code(t));
          hitSquares.push(sqName(tx, ty));
          uncoveredOther = true;
        }
      }
      if (hits.length) found.push({ kind: "discovered", by: [code(s)], targets: hits, arrows: hitSquares.map((h) => [sqName(x, y), h]) });
    }
  }
  if (has("double-check") && !uncoveredOther) {
    for (let i = found.length - 1; i >= 0; i--) if (found[i].kind === "discovered") found.splice(i, 1);
  }

  // Mate threat: a mate in one if the opponent passed, which we didn't have before.
  const threat = mateThreat(chess, move);
  if (threat) found.push({ kind: "mate-threat", by: [threat.color + threat.piece], targets: [them + "k"], arrows: [[threat.from, threat.to]] });

  // Free piece
  if (move.captured && move.captured !== "p") {
    // Everything won and lost in the run of captures this ends (anywhere on the
    // board), less what the opponent can still win back on this square.
    const won = exchangeNet(move, before) - exchangeLoss(VALUE[piece.type], attackersOf(grid, f, r, them), attackersOf(grid, f, r, us));
    if (won >= 2) {
      found.push({ kind: "free-piece", by: [code(piece)], targets: [them + move.captured], arrows: [] });
    }
  }

  // The rest are about the moved piece itself, which mustn't just be lost.
  if (hanging(grid, f, r)) return order(found);
  const value = VALUE[piece.type];

  // Trapped piece: an enemy piece we now attack that's in trouble and has nowhere safe to go.
  if (!chess.inCheck()) {
    const trapped: string[] = [];
    const trappedAt: [string, string][] = [];
    for (const [x, y] of attacks(grid, f, r)) {
      const t = grid[x][y];
      if (!t || t.color !== them || t.type === "p" || t.type === "k" || !hanging(grid, x, y)) continue;
      const sq = String.fromCharCode(97 + x) + (y + 1);
      const escapes = chess.moves({ square: sq as never, verbose: true });
      const safe = escapes.some((m) => {
        chess.move(m);
        const [tx, ty] = toXY(m.to);
        const ok = !hanging(toGrid(chess), tx, ty) || (m.captured ? VALUE[m.captured] >= VALUE[t.type] : false);
        chess.undo();
        return ok;
      });
      if (!safe) {
        trapped.push(code(t));
        trappedAt.push([move.to, sq]);
      }
    }
    if (trapped.length) found.push({ kind: "trapped", by: [code(piece)], targets: trapped, arrows: trappedAt });
  }

  // Battery: lined up with another of our sliders on one line, aimed at a piece.
  const ray = (x: number, y: number, dx: number, dy: number): [number, number] | null => {
    for (let tx = x + dx, ty = y + dy; inside(tx, ty); tx += dx, ty += dy) if (grid[tx][ty]) return [tx, ty];
    return null;
  };
  const slidesAlong = (p: Piece, dx: number, dy: number) => slideDirs(p.type).some(([a, b]) => a === dx && b === dy);
  for (const [df, dr] of slideDirs(piece.type)) {
    // The partner sits behind us, or we sit behind it; either way `front` leads along (df, dr).
    let front: [number, number] = [f, r];
    let back: [number, number] | null = null;
    const behind = ray(f, r, -df, -dr);
    if (behind && grid[behind[0]][behind[1]]!.color === us && slidesAlong(grid[behind[0]][behind[1]]!, df, dr)) back = behind;
    else {
      const ahead = ray(f, r, df, dr);
      if (ahead && grid[ahead[0]][ahead[1]]!.color === us && slidesAlong(grid[ahead[0]][ahead[1]]!, df, dr)) {
        back = [f, r];
        front = ahead;
      }
    }
    if (!back) continue;
    const target = ray(front[0], front[1], df, dr);
    const t = target && grid[target[0]][target[1]];
    if (t && t.color === them && t.type !== "p") {
      const by = [grid[front[0]][front[1]]!, grid[back[0]][back[1]]!].map(code);
      found.push({ kind: "battery", by, targets: [code(t)], arrows: [[sqName(back[0], back[1]), sqName(target![0], target![1])]] });
      break;
    }
  }

  // Fork
  const targets: { p: Piece; sq: string }[] = [];
  for (const [x, y] of attacks(grid, f, r)) {
    const t = grid[x][y];
    if (!t || t.color !== them || t.type === "p") continue;
    if (t.type === "k" || VALUE[t.type] > value || !attackersOf(grid, x, y, them).length) targets.push({ p: t, sq: sqName(x, y) });
  }
  if (targets.length >= 2) {
    // Most valuable first (the king, then the queen...).
    targets.sort((a, b) => VALUE[b.p.type] - VALUE[a.p.type]);
    found.push({ kind: "fork", by: [code(piece)], targets: targets.map((t) => code(t.p)), arrows: targets.map((t) => [move.to, t.sq]) });
  }

  // Pins and skewers along each line the piece slides on
  for (const [df, dr] of slideDirs(piece.type)) {
    let x = f + df;
    let y = r + dr;
    while (inside(x, y) && !grid[x][y]) {
      x += df;
      y += dr;
    }
    if (!inside(x, y)) continue;
    const front = grid[x][y]!;
    if (front.color !== them) continue;
    // The front piece could just capture along the line.
    if (slideDirs(front.type).some(([a, b]) => a === -df && b === -dr)) continue;
    let bx = x + df;
    let by = y + dr;
    while (inside(bx, by) && !grid[bx][by]) {
      bx += df;
      by += dr;
    }
    if (!inside(bx, by)) continue;
    const back = grid[bx][by]!;
    if (back.color !== them) continue;
    const backLoses = back.type === "k" || VALUE[back.type] > value || !attackersOf(grid, bx, by, them).length;
    if (front.type !== "k" && (back.type === "k" || (VALUE[back.type] > VALUE[front.type] && backLoses))) {
      if (front.type !== "p") {
        found.push({ kind: "pin", by: [code(piece)], targets: [code(front), code(back)], arrows: [[move.to, sqName(bx, by)]] });
      }
    } else if ((front.type === "k" || VALUE[front.type] > VALUE[back.type]) && back.type !== "p" && backLoses) {
      found.push({ kind: "skewer", by: [code(piece)], targets: [code(front), code(back)], arrows: [[move.to, sqName(bx, by)]] });
    }
  }

  return order(found);
}

/** Most striking first; at most three kinds (badges fit on a square), each with all its instances. */
export function order(found: TacticDetail[]): TacticDetail[] {
  const kinds = TACTIC_ORDER.filter((k) => found.some((d) => d.kind === k)).slice(0, 3);
  return kinds.flatMap((k) => found.filter((d) => d.kind === k));
}

/** The move that could mate next if the opponent passed, if that threat is new with this move. */
function mateThreat(chess: Chess, move: Move): Move | null {
  if (chess.inCheck() || chess.isGameOver()) return null;
  const mateInOne = (fen: string): Move | null => {
    let c: Chess;
    try {
      c = new Chess(fen);
    } catch {
      return null;
    }
    for (const m of c.moves({ verbose: true })) {
      c.move(m);
      const mate = c.isCheckmate();
      c.undo();
      if (mate) return m;
    }
    return null;
  };
  // The same position with us to move again (no en passant).
  const parts = chess.fen().split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const threat = mateInOne(parts.join(" "));
  if (!threat || mateInOne(move.before)) return null;
  return threat;
}

/**
 * Material the opponent nets by capturing on a square holding a piece worth
 * `value`, trading off the cheapest attacker each time (a standard exchange
 * count, ignoring pieces lined up behind others).
 */
function exchangeLoss(value: number, enemy: number[], ours: number[]): number {
  const e = [...enemy].sort((a, b) => a - b);
  const o = [...ours].sort((a, b) => a - b);
  if (!e.length) return 0;
  const gain: number[] = [value];
  let onSquare = e[0];
  let ei = 1;
  let oi = 0;
  for (let enemyTurn = false; ; enemyTurn = !enemyTurn) {
    const next = enemyTurn ? e[ei] : o[oi];
    if (next === undefined) break;
    gain.push(onSquare - gain[gain.length - 1]);
    onSquare = next;
    if (enemyTurn) ei++;
    else oi++;
  }
  for (let i = gain.length - 1; i > 0; i--) gain[i - 1] = -Math.max(-gain[i - 1], gain[i]);
  return Math.max(0, gain[0]);
}

/**
 * What the mover has won over the run of back-to-back captures that `move`
 * ends, by either side and anywhere on the board (going back through `before`
 * until a move that didn't capture), in pawns.
 */
function exchangeNet(move: Move, before: Move[]): number {
  let net = VALUE[move.captured!];
  let sign = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i];
    if (!m.captured) break;
    net += sign * VALUE[m.captured];
    sign = -sign;
  }
  return net;
}

/** `details` plus a sacrifice by the piece that made `move`, in badge order. */
export function withSacrifice(details: TacticDetail[], move: Move): TacticDetail[] {
  return order([...details, { kind: "sacrifice", by: [move.color + move.piece], targets: [], arrows: [] }]);
}

/**
 * Whether `move` (just played on `chess`) gives up 2+ pawns' worth: the
 * opponent can win at least that much on the square it went to, counting what
 * it captured. Whether the sacrifice is any good is for the caller to check.
 */
export function sacrificeCandidate(chess: Chess, move: Move): boolean {
  const grid = toGrid(chess);
  const [f, r] = toXY(move.to);
  const piece = grid[f][r];
  if (!piece || piece.type === "k" || chess.isCheckmate()) return false;
  const them: Color = piece.color === "w" ? "b" : "w";
  const enemy = attackersOf(grid, f, r, them);
  if (!enemy.length) return false;
  const lost = exchangeLoss(VALUE[piece.type], enemy, attackersOf(grid, f, r, piece.color));
  const won = move.captured ? VALUE[move.captured] : 0;
  return won - lost <= -2;
}

function findKing(grid: Grid, color: Color): [number, number] | null {
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      const p = grid[x][y];
      if (p && p.type === "k" && p.color === color) return [x, y];
    }
  }
  return null;
}
