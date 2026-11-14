// Backend access. Inside Tauri this calls the Rust commands in src-tauri/src/lib.rs;
// in a plain browser (npm run dev) it falls back to an in-memory mock so the UI
// can be worked on without building the native app.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { previewBotMove, previewJudge } from "./previewBot";
import { SAMPLE_PUZZLES } from "./samplePuzzles";

export interface Puzzle {
  id: string;
  fen: string;
  /** UCI moves, space separated. moves[0] is the opponent's move that sets up the puzzle. */
  moves: string;
  rating: number;
  themes: string[];
}

export interface Profile {
  rating: number;
  rd: number;
  solved: number;
  attempted: number;
  streak: number;
}

export interface AttemptResult {
  rated: boolean;
  ratingBefore: number;
  ratingAfter: number;
}

/** A position analysed by Stockfish. */
export interface PositionEval {
  /** Centipawns for the side to move (mates near ±30000). */
  score: number;
  /** The best move (UCI), or null with no legal moves. */
  best: string | null;
  /** The second-best move's score (same view); null with only one legal move (or unknown). */
  second?: number | null;
}

export interface ThemeCount {
  name: string;
  count: number;
}

export interface Api {
  nextPuzzle(theme: string | null, offset: number, exclude: string | null): Promise<Puzzle | null>;
  getPuzzle(id: string): Promise<Puzzle | null>;
  recordAttempt(puzzleId: string, solved: boolean, usedHint: boolean): Promise<AttemptResult>;
  getProfile(): Promise<Profile>;
  listThemes(): Promise<ThemeCount[]>;
  getSettings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
  /** The bot's reply (UCI) after `moves` from `fen` at `level` 1-5; null if the game is over. */
  botMove(fen: string, moves: string[], level: number): Promise<string | null>;
  /** [best, mv] scores (centipawns, side to move) for `mv` after `moves` from `fen`; null if unknown. */
  judgeMove(fen: string, moves: string[], mv: string, ms?: number): Promise<[number, number] | null>;
  /** Stockfish on the position after `moves` from `fen`: score (side to move) and best move. Rejects without Stockfish. */
  analysePosition(fen: string, moves: string[], ms?: number): Promise<PositionEval>;
}

const tauriApi: Api = {
  nextPuzzle: (theme, offset, exclude) => invoke("next_puzzle", { theme, offset, exclude }),
  getPuzzle: (id) => invoke("get_puzzle", { id }),
  recordAttempt: (puzzleId, solved, usedHint) => invoke("record_attempt", { puzzleId, solved, usedHint }),
  getProfile: () => invoke("get_profile"),
  listThemes: () => invoke("list_themes"),
  getSettings: () => invoke("get_settings"),
  setSetting: (key, value) => invoke("set_setting", { key, value }),
  botMove: (fen, moves, level) => invoke("bot_move", { fen, moves, level }),
  judgeMove: (fen, moves, mv, ms) => invoke("judge_move", { fen, moves, mv, ms: ms ?? null }),
  analysePosition: (fen, moves, ms) => invoke("analyse_position", { fen, moves, ms: ms ?? null }),
};

function createMockApi(): Api {
  const profile: Profile = { rating: 1500, rd: 350, solved: 0, attempted: 0, streak: 0 };
  const attempted = new Set<string>();
  const settings: Record<string, string> = {};
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem("stalemate.settings") ?? "{}"));
  } catch {
    // Storage unavailable; settings just won't persist.
  }

  return {
    async nextPuzzle(theme, _offset, exclude) {
      const matching = SAMPLE_PUZZLES.filter((p) => !theme || p.themes.includes(theme));
      const pool = matching.length > 1 ? matching.filter((p) => p.id !== exclude) : matching;
      const fresh = pool.filter((p) => !attempted.has(p.id));
      const list = fresh.length ? fresh : pool;
      return list.length ? list[Math.floor(Math.random() * list.length)] : null;
    },
    async getPuzzle(id) {
      return SAMPLE_PUZZLES.find((p) => p.id === id) ?? null;
    },
    async recordAttempt(puzzleId, solved, usedHint) {
      const before = profile.rating;
      const rated = !attempted.has(puzzleId);
      attempted.add(puzzleId);
      if (rated) {
        const puzzle = SAMPLE_PUZZLES.find((p) => p.id === puzzleId)!;
        const expected = 1 / (1 + 10 ** ((puzzle.rating - before) / 400));
        const win = solved && !usedHint;
        profile.rating = before + 32 * ((win ? 1 : 0) - expected);
        profile.attempted++;
        if (win) {
          profile.solved++;
          profile.streak++;
        } else {
          profile.streak = 0;
        }
      }
      return { rated, ratingBefore: before, ratingAfter: profile.rating };
    },
    async getProfile() {
      return { ...profile };
    },
    async listThemes() {
      const counts = new Map<string, number>();
      for (const p of SAMPLE_PUZZLES) for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
    async getSettings() {
      return { ...settings };
    },
    async botMove(fen, moves, level) {
      return previewBotMove(fen, moves, level);
    },
    // No engine in the browser: a rough material-only judge.
    async judgeMove(fen, moves, mv) {
      return previewJudge(fen, moves, mv);
    },
    async analysePosition() {
      throw new Error("no Stockfish in the browser preview");
    },
    async setSetting(key, value) {
      settings[key] = value;
      try {
        localStorage.setItem("stalemate.settings", JSON.stringify(settings));
      } catch {
        // Ignore; see above.
      }
    },
  };
}

export const api: Api = isTauri() ? tauriApi : createMockApi();
