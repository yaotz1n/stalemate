// Stand-in bot for the browser preview (npm run dev), where the Rust engine
// isn't available. It looks two plies ahead on material plus a little
// positional sense (central, developed pieces), so it's much weaker than the
// real bot at the higher levels; it's just enough to test the UI.

import { Chess, type Move } from "chess.js";

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** Small bonuses (centipawns) so quiet moves don't all tie: knights and bishops out and central, pawns advanced in the middle. */
function placement(type: string, color: string, file: number, rank: number): number {
  const r = color === "w" ? rank : 7 - rank; // 0 = own back rank
  const centre = 3.5 - Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5)); // 0 at the edge .. 3 in the middle
  switch (type) {
    case "n":
      return centre * 10 - (r === 0 ? 15 : 0);
    case "b":
      return centre * 5 - (r === 0 ? 15 : 0);
    case "q":
      return centre * 2;
    case "p":
      return file >= 2 && file <= 5 ? r * 4 : 0;
    case "k":
      return r === 0 && (file <= 2 || file >= 6) ? 20 : 0; // tucked away
    default:
      return 0;
  }
}

function material(chess: Chess): number {
  let score = 0;
  chess.board().forEach((row, i) =>
    row.forEach((p, file) => {
      if (p) score += (p.color === chess.turn() ? 1 : -1) * (VALUE[p.type] + placement(p.type, p.color, file, 7 - i));
    }),
  );
  return score;
}

/** Score for the side that just moved. */
function afterMove(chess: Chess, depth: number): number {
  if (chess.isCheckmate()) return 100_000;
  if (chess.isDraw() || chess.isStalemate()) return 0;
  if (depth === 0) return -material(chess);
  let best = -Infinity;
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    best = Math.max(best, afterMove(chess, depth - 1));
    chess.undo();
  }
  return -best;
}

export function previewBotMove(fen: string, moves: string[], level: number): string | null {
  const chess = new Chess(fen);
  for (const uci of moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const options: Move[] = chess.moves({ verbose: true });
  if (!options.length) return null;
  const depth = level >= 3 ? 1 : 0;
  const noise = [0, 250, 150, 80, 40, 10][level] ?? 10;
  let best: Move = options[0];
  let bestScore = -Infinity;
  for (const m of options) {
    chess.move(m);
    const score = afterMove(chess, depth) + Math.random() * noise;
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best.from + best.to + (best.promotion ?? "");
}

/**
 * Stand-in for the engine's move judging in the preview: [best, mv] scores for
 * the side to move, by material two plies ahead. Rough, but enough to see move
 * quality and the eval bar work.
 */
export function previewJudge(fen: string, moves: string[], mv: string): [number, number] | null {
  const chess = new Chess(fen);
  for (const uci of moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  let best = -Infinity;
  let score: number | null = null;
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const s = Math.max(-30_000, Math.min(30_000, afterMove(chess, 1)));
    chess.undo();
    best = Math.max(best, s);
    if (m.from + m.to + (m.promotion ?? "") === mv) score = s;
  }
  return score === null ? null : [best, score];
}
