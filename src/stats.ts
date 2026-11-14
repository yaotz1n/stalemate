// Player history and statistics: finished bot games (kept so they can be
// reviewed move by move) and running puzzle totals. Both live in the settings
// table as JSON, under ARCHIVE_KEY and PUZZLE_STATS_KEY.

import { Chess, type Move } from "chess.js";
import { api } from "./api";
import type { PieceColor } from "./pieces";
import { classify, gameAccuracy, pliesOf } from "./quality";
import { tacticsOf, type Tactic } from "./tactics";

const ARCHIVE_KEY = "archive";
const PUZZLE_STATS_KEY = "puzzleStats";
/** Oldest games are dropped past this many. */
const MAX_GAMES = 500;

export type Counts = Partial<Record<string, number>>;

export interface GameResultInfo {
  /** null for a draw. */
  winner: PieceColor | null;
  reason: string;
}

/** Totals for one finished game, worked out once when it ends. */
export interface GameSummary {
  /** The player's moves. */
  moves: number;
  /** Enemy pieces the player took, by type ("q", "r"...). */
  captured: Counts;
  /** The player's pieces the bot took, by type. */
  lost: Counts;
  checks: number;
  castles: number;
  promotions: number;
  /** Tactic badges the player earned, by tactic. */
  tactics: Counts;
  /** Tactics the bot played against the player. */
  enemyTactics: Counts;
  takebacks: number;
  /** The player's moves by quality ("best", "blunder"...), for the ones the engine judged. */
  quality?: Counts;
}

export interface GameRecord {
  id: string;
  /** When it ended (ISO). */
  date: string;
  fen: string;
  /** UCI moves from `fen`. */
  moves: string[];
  playerColor: PieceColor;
  level: number;
  result: GameResultInfo;
  /** Plies of the player's sound sacrifices. */
  sacs?: number[];
  /** The engine's verdict per move (see GameSave.evals). */
  evals?: Record<number, [number, number]>;
  /** Stockfish's preferred move where the player's wasn't the best (see GameSave.bests). */
  bests?: Record<number, string>;
  /** Which grader the grades come from (see GRADER in game.ts). */
  graded?: string;
  /** Plies of only-good best moves (★). */
  stars?: number[];
  summary: GameSummary;
}

export interface PuzzleStats {
  attempted: number;
  /** Solved with no mistakes and no hints (what counts for the rating). */
  solved: number;
  /** Attempts where a hint was used. */
  hintsUsed: number;
  bestStreak: number;
  peakRating: number;
  /** Sum of the ratings of solved puzzles (for the average). */
  solvedRatingSum: number;
  hardestSolved: number;
  /** Tactic badges earned in puzzles. */
  tactics: Counts;
  /** Themes of solved puzzles. */
  themes: Counts;
}

export const EMPTY_PUZZLE_STATS: PuzzleStats = {
  attempted: 0,
  solved: 0,
  hintsUsed: 0,
  bestStreak: 0,
  peakRating: 0,
  solvedRatingSum: 0,
  hardestSolved: 0,
  tactics: {},
  themes: {},
};

export function add(counts: Counts, key: string, n = 1) {
  counts[key] = (counts[key] ?? 0) + n;
}

/** Works out a finished game's totals from its moves. */
export function summarize(
  history: Move[],
  playerColor: PieceColor,
  takebacks: number,
  sacPlies: number[] = [],
  evals: Map<number, [number, number]> = new Map(),
): GameSummary {
  const s: GameSummary = { moves: 0, captured: {}, lost: {}, checks: 0, castles: 0, promotions: 0, tactics: {}, enemyTactics: {}, takebacks, quality: {} };
  for (const m of history) {
    const mine = m.color === playerColor;
    if (m.captured) add(mine ? s.captured : s.lost, m.captured);
    for (const t of tacticsOf(new Chess(m.after), m, history.slice(0, history.indexOf(m)))) add(mine ? s.tactics : s.enemyTactics, t);
    if (!mine) continue;
    const ply = history.indexOf(m) + 1;
    if (sacPlies.includes(ply)) add(s.tactics, "sacrifice");
    const judged = evals.get(ply);
    if (judged) add(s.quality!, classify(judged[0], judged[1]));
    s.moves++;
    if (m.san.includes("+") || m.san.includes("#")) s.checks++;
    if (m.isKingsideCastle() || m.isQueensideCastle()) s.castles++;
    if (m.isPromotion()) s.promotions++;
  }
  return s;
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class StatsStore {
  archive: GameRecord[] = [];
  puzzles: PuzzleStats = structuredClone(EMPTY_PUZZLE_STATS);

  async load() {
    const raw = await api.getSettings();
    this.archive = parse(raw[ARCHIVE_KEY], []);
    this.puzzles = { ...structuredClone(EMPTY_PUZZLE_STATS), ...parse(raw[PUZZLE_STATS_KEY], {}) };
  }

  /** Adds a finished game, or updates it (a takeback after the end, then a new ending). */
  saveGame(record: GameRecord) {
    const i = this.archive.findIndex((g) => g.id === record.id);
    if (i >= 0) this.archive[i] = record;
    else this.archive.push(record);
    if (this.archive.length > MAX_GAMES) this.archive.splice(0, this.archive.length - MAX_GAMES);
    api.setSetting(ARCHIVE_KEY, JSON.stringify(this.archive)).catch((e) => console.error("saving game history failed", e));
  }

  /** Adds finished games from elsewhere (imported), keeping the history in date order. */
  addGames(records: GameRecord[]) {
    this.archive.push(...records);
    this.archive.sort((a, b) => a.date.localeCompare(b.date));
    if (this.archive.length > MAX_GAMES) this.archive.splice(0, this.archive.length - MAX_GAMES);
    api.setSetting(ARCHIVE_KEY, JSON.stringify(this.archive)).catch((e) => console.error("saving game history failed", e));
  }

  /** A game taken back from its ending (and so no longer finished). */
  unsaveGame(id: string) {
    const i = this.archive.findIndex((g) => g.id === id);
    if (i < 0) return;
    this.archive.splice(i, 1);
    api.setSetting(ARCHIVE_KEY, JSON.stringify(this.archive)).catch((e) => console.error("saving game history failed", e));
  }

  updatePuzzles(fn: (s: PuzzleStats) => void) {
    fn(this.puzzles);
    api.setSetting(PUZZLE_STATS_KEY, JSON.stringify(this.puzzles)).catch((e) => console.error("saving puzzle stats failed", e));
  }
}

/** Totals over every finished bot game. */
export function gameTotals(archive: GameRecord[]) {
  const t = {
    games: archive.length,
    wins: 0,
    losses: 0,
    draws: 0,
    resignations: 0,
    checkmatesGiven: 0,
    moves: 0,
    captured: {} as Counts,
    lost: {} as Counts,
    checks: 0,
    castles: 0,
    promotions: 0,
    takebacks: 0,
    tactics: {} as Counts,
    enemyTactics: {} as Counts,
    quality: {} as Counts,
    /** Average and best accuracy over fully graded games (null with none). */
    accuracy: null as number | null,
    bestAccuracy: null as number | null,
    byLevel: new Map<number, { w: number; l: number; d: number }>(),
    bestWinStreak: 0,
    winStreak: 0,
    /** Fewest moves in a win. */
    quickestWin: 0,
    longestGame: 0,
  };
  let streak = 0;
  for (const g of archive) {
    const won = g.result.winner === g.playerColor;
    const lost = g.result.winner !== null && !won;
    if (won) t.wins++;
    else if (lost) t.losses++;
    else t.draws++;
    if (lost && g.result.reason === "resignation") t.resignations++;
    if (won && g.result.reason === "checkmate") t.checkmatesGiven++;
    streak = won ? streak + 1 : 0;
    t.bestWinStreak = Math.max(t.bestWinStreak, streak);
    const lv = t.byLevel.get(g.level) ?? { w: 0, l: 0, d: 0 };
    if (won) lv.w++;
    else if (lost) lv.l++;
    else lv.d++;
    t.byLevel.set(g.level, lv);
    const s = g.summary;
    t.moves += s.moves;
    t.checks += s.checks;
    t.castles += s.castles;
    t.promotions += s.promotions;
    t.takebacks += s.takebacks;
    for (const [k, n] of Object.entries(s.captured)) add(t.captured, k, n);
    for (const [k, n] of Object.entries(s.lost)) add(t.lost, k, n);
    for (const [k, n] of Object.entries(s.tactics)) add(t.tactics, k, n);
    for (const [k, n] of Object.entries(s.enemyTactics)) add(t.enemyTactics, k, n);
    // Grades come from the saved engine scores, so a change to the grading rules applies to old games too.
    for (const [k, n] of Object.entries(g.evals ? gradeGame(g) : (s.quality ?? {}))) add(t.quality, k, n);
    if (won && (!t.quickestWin || s.moves < t.quickestWin)) t.quickestWin = s.moves;
    t.longestGame = Math.max(t.longestGame, s.moves);
  }
  t.winStreak = streak;
  const accuracies = archive.map(accuracyOf).filter((a): a is number => a !== null);
  if (accuracies.length) {
    t.accuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    t.bestAccuracy = Math.max(...accuracies);
  }
  return t;
}

/** The player's accuracy in a saved game (0-100), or null if it isn't fully graded. */
export function accuracyOf(g: GameRecord): number | null {
  if (!g.evals) return null;
  return gameAccuracy(g.evals, pliesOf(g.playerColor, g.fen.split(" ")[1] === "b" ? "b" : "w", g.moves.length));
}

/** The player's moves in a saved game by quality, from its engine scores. */
function gradeGame(g: GameRecord): Counts {
  const counts: Counts = {};
  const firstMover = g.fen.split(" ")[1] === "b" ? "b" : "w";
  for (const [k, v] of Object.entries(g.evals ?? {})) {
    const ply = Number(k);
    const mover = ply % 2 === 1 ? firstMover : firstMover === "w" ? "b" : "w";
    if (mover === g.playerColor) add(counts, classify(v[0], v[1]));
  }
  return counts;
}

export function sum(counts: Counts) {
  return Object.values(counts).reduce((a: number, b) => a + (b ?? 0), 0);
}

export type { Tactic };
