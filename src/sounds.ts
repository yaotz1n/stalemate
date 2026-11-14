// Sound effects. Each event maps to a player function. The Arcade pack plays
// recorded samples (public/sounds/arcade, CC0) with pitch variation.

import type { PieceType } from "./pieces";

export type SoundEvent =
  | "move"
  | "capture"
  | "check"
  | "castle"
  | "promote"
  | "correct"
  | "wrong"
  | "solved"
  | "hint"
  | "pickup"
  | "tick"
  | "build"
  | "thud"
  | "crumble";

export interface SoundOptions {
  /** Piece that moved, so heavier pieces can sound heavier. */
  piece?: PieceType;
  /** Position in a sequence (correct moves in a puzzle, rating ticks, build rings). */
  step?: number;
  /** Seconds from now, e.g. to land a sound when an animated piece lands. */
  delay?: number;
}

export interface SoundPack {
  id: string;
  name: string;
  play(event: SoundEvent, ctx: AudioContext, out: AudioNode, opts: SoundOptions): void;
  /** Loads any sample files ahead of time so the first play isn't late. */
  preload?(ctx: AudioContext): void;
}

const ARCADE_FILES = [
  "move-1", "move-2", "move-3", "move-4", "move-5",
  "capture-1", "capture-2", "capture-3", "capture-slide",
  "pickup", "wrong", "chime", "tick", "solved", "hint", "build", "thud",
  "crumble-1", "crumble-2", "crumble-3", "crumble-4",
];

/** Playback rate per piece: lighter pieces knock higher, heavier ones lower. */
const PIECE_PITCH: Record<PieceType, number> = { p: 1.12, n: 1, b: 1, r: 0.92, q: 0.88, k: 0.85 };

/** Major-arpeggio steps (semitones) for the rising "correct" chime. */
const CHIME_STEPS = [0, 4, 7, 12, 16, 19, 24];

const semis = (n: number) => 2 ** (n / 12);
const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

export function arcadePack(folder = "/sounds/arcade"): SoundPack {
  const buffers = new Map<string, AudioBuffer>();
  let loading: Promise<void> | null = null;

  const load = (ctx: AudioContext) =>
    (loading ??= Promise.all(
      ARCADE_FILES.map((name) =>
        fetch(`${folder}/${name}.wav`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${name}: HTTP ${r.status}`))))
          .then((b) => ctx.decodeAudioData(b))
          .then((buf) => void buffers.set(name, buf))
          .catch((e) => console.warn("arcade sound failed to load", e)),
      ),
    ).then(() => undefined));

  const sample = (ctx: AudioContext, out: AudioNode, name: string, rate: number, gain: number, delay = 0) => {
    const buf = buffers.get(name);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(ctx.currentTime + Math.max(0, delay));
  };

  return {
    id: "arcade",
    name: "Arcade",
    preload: (ctx) => void load(ctx),
    play(event, ctx, out, opts) {
      void load(ctx).then(() => {
        const d = opts.delay ?? 0;
        const weight = PIECE_PITCH[opts.piece ?? "n"];
        const step = opts.step ?? 0;
        const knock = (gain = 0.9, at = d) =>
          sample(ctx, out, pick(["move-1", "move-2", "move-3", "move-4", "move-5"]), weight * jitter(0.05), gain, at);
        const chime = (n: number, gain = 0.45, at = d) =>
          sample(ctx, out, "chime", semis(CHIME_STEPS[Math.min(n, CHIME_STEPS.length - 1)]), gain, at);

        switch (event) {
          case "move":
            knock();
            break;
          case "capture":
            sample(ctx, out, pick(["capture-1", "capture-2", "capture-3"]), weight * jitter(0.05), 1, d);
            sample(ctx, out, "capture-slide", jitter(0.06), 0.45, d + 0.05);
            break;
          case "castle":
            knock();
            knock(0.8, d + 0.09);
            break;
          case "check":
            sample(ctx, out, "capture-2", weight * jitter(0.04), 0.95, d);
            break;
          case "promote":
            knock();
            chime(4, 0.35, d + 0.06);
            break;
          case "correct":
            chime(step, 0.45, d + 0.04);
            break;
          case "wrong":
            sample(ctx, out, "wrong", 0.85, 1, d);
            break;
          case "solved":
            chime(step, 0.5, d + 0.04);
            sample(ctx, out, "solved", 1, 1, d + 0.16);
            break;
          case "hint":
            sample(ctx, out, "hint", 1, 0.4, d);
            break;
          case "pickup":
            sample(ctx, out, "pickup", jitter(0.08), 0.45, d);
            break;
          case "tick":
            sample(ctx, out, "tick", Math.max(0.5, Math.min(2, semis(step * 0.6))), 0.35, d);
            break;
          case "build":
            sample(ctx, out, "build", semis(step * 1.5), 0.18, d);
            break;
          case "thud":
            sample(ctx, out, "thud", 0.8 * jitter(0.03), 1, d);
            break;
          case "crumble":
            sample(ctx, out, pick(["crumble-1", "crumble-2", "crumble-3", "crumble-4"]), jitter(0.12), 0.55, d);
            break;
        }
      });
    },
  };
}

export class Sounds {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  enabled = true;
  volume = 0.7;

  constructor(public pack: SoundPack) {}

  /** Loads the pack's samples ahead of time so the first play isn't late. */
  preload() {
    this.pack.preload?.(this.context());
  }

  play(event: SoundEvent, opts: SoundOptions = {}) {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
    this.gain!.gain.value = this.volume;
    this.pack.play(event, ctx, this.gain!, opts);
  }

  private context() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }
}
