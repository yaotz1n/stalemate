// User preferences: defaults, the theme catalogs, and loading/saving through
// the backend (stored in user.db). Everything visual reads from here so new
// themes only need an entry in one of these lists.

import { api } from "./api";

/**
 * Off: instant moves, no effects. Normal: pieces slide (and lift when held,
 * captures fade, the rating counter rolls). Fancy: Normal plus pieces arcing
 * through the air (knights hop) and squashing as they land, a little slower so
 * the arc reads, and the board building out and crumbling.
 */
export const ANIMATION_SPEEDS = [
  { id: "off", name: "Off", ms: 0 },
  { id: "normal", name: "Normal", ms: 200 },
  { id: "fancy", name: "Fancy", ms: 280 },
];


export interface Settings {
  /** Which screen is showing: "puzzles" or "play" (against the bot). */
  mode: string;
  /** Last bot level picked (1-5). */
  botLevel: number;
  /** Last color picked to play: "w", "b" or "random". */
  botColor: string;
  /** A PIECE_SETS id (src/pieces.ts). */
  pieceSet: string;
  animation: string;
  sound: boolean;
  volume: number;
  showLegal: boolean;
  showCoords: boolean;
  clickToMove: boolean;
  /** Fork / pin / skewer badges on the player's own moves. */
  showTactics: boolean;
  /** Also badge the opponent's tactics (in yellow). */
  enemyTactics: boolean;
  /** A move with tactic badges gets its last-move highlight in the badge's color. */
  tacticHighlight: boolean;
  /** Arrows showing what each tactic badge's piece attacks. */
  tacticArrows: boolean;
  /** Bot games: grade the player's moves (best move, inaccuracy, mistake, blunder). */
  showQuality: boolean;
  /** Bot games: the evaluation bar beside the board. */
  evalBar: boolean;
  /** Bot games: while playing, grade and badge only your own moves (the full review opens once the game ends). */
  fairLive: boolean;
  autoNext: boolean;
  kingGlow: boolean;
  /** Sandbox for testing visuals and sounds: move both sides, nothing scored or saved. */
  devMode: boolean;
}

export const DEFAULTS: Settings = {
  mode: "puzzles",
  botLevel: 2,
  botColor: "w",
  pieceSet: "cburnett",
  animation: "normal",
  sound: true,
  volume: 0.7,
  showLegal: true,
  showCoords: true,
  clickToMove: true,
  showTactics: true,
  enemyTactics: false,
  tacticHighlight: true,
  tacticArrows: true,
  showQuality: true,
  evalBar: true,
  fairLive: true,
  autoNext: true,
  kingGlow: false,
  devMode: false,
};

export async function loadSettings(): Promise<Settings> {
  const raw = await api.getSettings();
  const s: Settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw[key];
    if (v === undefined) continue;
    const def = DEFAULTS[key];
    (s as unknown as Record<string, unknown>)[key] =
      typeof def === "boolean" ? v === "true" : typeof def === "number" ? Number(v) : v;
  }
  // Old speeds (Fast/Slow) no longer exist.
  if (!ANIMATION_SPEEDS.some((a) => a.id === s.animation)) s.animation = DEFAULTS.animation;
  return s;
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  return api.setSetting(key, String(value));
}
