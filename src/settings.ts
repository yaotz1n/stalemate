// User preferences: defaults, the theme catalogs, and loading/saving through
// the backend (stored in user.db). Everything visual reads from here so new
// themes only need an entry in one of these lists.

import { api } from "./api";

export interface BoardTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: "walnut", name: "Walnut", light: "#f0d9b5", dark: "#b58863" },
  { id: "moss", name: "Moss", light: "#ebecd0", dark: "#7b9a5a" },
  { id: "slate", name: "Slate", light: "#dee3e6", dark: "#8ca2ad" },
  { id: "rose", name: "Rose", light: "#f3e3e6", dark: "#c08a97" },
  { id: "midnight", name: "Midnight", light: "#a9b3c6", dark: "#4f5b77" },
  { id: "sand", name: "Sand", light: "#f6eedc", dark: "#d1b37f" },
  { id: "simple-dark", name: "Simple Dark", light: "#bbaf9b", dark: "#453f3a" },
];

export const ANIMATION_SPEEDS = [
  { id: "off", name: "Off", ms: 0 },
  { id: "fast", name: "Fast", ms: 120 },
  { id: "normal", name: "Normal", ms: 200 },
  { id: "slow", name: "Slow", ms: 320 },
];


/** Overall feel. Classic is the original look and sound; Arcade adds motion and recorded sounds. */
export const STYLES = [
  { id: "arcade", name: "Arcade" },
  { id: "classic", name: "Classic" },
];

export interface Settings {
  style: string;
  /** A BOARD_THEMES id, or "custom" to use customLight/customDark. */
  boardTheme: string;
  customLight: string;
  customDark: string;
  animation: string;
  sound: boolean;
  volume: number;
  showLegal: boolean;
  showCoords: boolean;
  clickToMove: boolean;
  autoNext: boolean;
  kingGlow: boolean;
  /** Sandbox for testing visuals and sounds: move both sides, nothing scored or saved. */
  devMode: boolean;
}

export const DEFAULTS: Settings = {
  style: "arcade",
  boardTheme: "walnut",
  customLight: "#f0d9b5",
  customDark: "#b58863",
  animation: "normal",
  sound: true,
  volume: 0.7,
  showLegal: true,
  showCoords: true,
  clickToMove: false,
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
  return s;
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  return api.setSetting(key, String(value));
}
