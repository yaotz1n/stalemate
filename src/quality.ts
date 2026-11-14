// Move quality and win chances from the engine's scores (centipawns, from the
// mover's point of view). The win-chance curve is the one Lichess fitted to
// its games; the quality thresholds are Lichess's too (a drop of 5 / 10 / 15
// percentage points in win chance is an inaccuracy / mistake / blunder).

export type Quality = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

/** Scores past this are mates (the engine's MATE is 30000, less the distance). */
const MATE_SCORE = 29_000;

/** Chance of winning (0-100) for the side with `cp` centipawns of advantage. */
export function winChance(cp: number): number {
  const c = Math.max(-2000, Math.min(2000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/**
 * How good a move was, from the best move's score and its own (both for the
 * side that moved). "Best" is only the engine's top choice (or one scoring the
 * same); anything a little behind it is "good".
 */
export function classify(best: number, score: number): Quality {
  if (score >= best) return "best";
  const drop = winChance(best) - winChance(score);
  if (drop < 5) return "good";
  if (drop < 10) return "inaccuracy";
  if (drop < 15) return "mistake";
  return "blunder";
}

/** Symbols for the move list and badges ("good" has none). */
export const QUALITY_SYMBOL: Record<Quality, string> = {
  best: "★",
  good: "",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

export const QUALITY_NAME: Record<Quality, string> = {
  best: "Best move",
  good: "Good move",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

/** "+1.4", "-0.3", "M3", "-M2": a score (White's view) as shown on the eval bar. */
export function formatEval(cpWhite: number): string {
  if (Math.abs(cpWhite) >= MATE_SCORE) {
    const plies = 30_000 - Math.abs(cpWhite);
    return `${cpWhite < 0 ? "-" : ""}M${Math.max(1, Math.ceil(plies / 2))}`;
  }
  const pawns = cpWhite / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

/**
 * How accurate a move was (0-100), from the win chance it gave up: Lichess's
 * formula (100 for the best move, about 50 for a 15-point drop).
 */
export function moveAccuracy(best: number, score: number): number {
  const drop = Math.max(0, winChance(best) - winChance(score));
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

/**
 * The player's accuracy over a game (0-100, the average of their moves), from
 * the engine's verdicts (ply -> [best, score]); null until every one of the
 * player's moves (`plies`) has been judged.
 */
export function gameAccuracy(evals: Map<number, [number, number]> | Record<number, [number, number]>, plies: number[]): number | null {
  if (!plies.length) return null;
  const get = (p: number) => (evals instanceof Map ? evals.get(p) : evals[p]);
  let total = 0;
  for (const p of plies) {
    const e = get(p);
    if (!e) return null;
    total += moveAccuracy(e[0], e[1]);
  }
  return total / plies.length;
}

/** The plies (1-based) of `color`'s moves in a game of `count` moves from a start position with `firstMover` to move. */
export function pliesOf(color: "w" | "b", firstMover: "w" | "b", count: number): number[] {
  const out: number[] = [];
  for (let ply = color === firstMover ? 1 : 2; ply <= count; ply += 2) out.push(ply);
  return out;
}
