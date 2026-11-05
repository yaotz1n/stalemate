// Sound effects. Each event maps to a player function. The Classic pack
// synthesizes its sounds with Web Audio; the Arcade pack plays recorded
// samples (public/sounds/arcade, CC0) with pitch variation.

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
  // Arcade-only events; the Classic pack stays silent for these.
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

function tone(ctx: AudioContext, out: AudioNode, freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.3) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function knock(ctx: AudioContext, out: AudioNode, freq: number, dur: number, gain: number, start = 0) {
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(out);
  src.start(ctx.currentTime + start);
}

export const synthPack: SoundPack = {
  id: "synth",
  name: "Simple",
  play(event, ctx, out) {
    switch (event) {
      case "move":
        knock(ctx, out, 1800, 0.06, 1.4);
        break;
      case "capture":
        knock(ctx, out, 900, 0.1, 2.2);
        knock(ctx, out, 2400, 0.05, 0.8, 0.02);
        break;
      case "castle":
        knock(ctx, out, 1800, 0.06, 1.2);
        knock(ctx, out, 1600, 0.06, 1.2, 0.09);
        break;
      case "check":
        knock(ctx, out, 1800, 0.06, 1.2);
        tone(ctx, out, 880, 0.02, 0.18, "triangle", 0.12);
        break;
      case "promote":
        knock(ctx, out, 1800, 0.06, 1.2);
        tone(ctx, out, 660, 0.03, 0.12, "triangle", 0.12);
        tone(ctx, out, 990, 0.1, 0.18, "triangle", 0.12);
        break;
      case "correct":
        tone(ctx, out, 880, 0, 0.15, "sine", 0.15);
        break;
      case "wrong":
        tone(ctx, out, 220, 0, 0.25, "square", 0.06);
        tone(ctx, out, 185, 0.08, 0.3, "square", 0.06);
        break;
      case "solved":
        [523, 659, 784, 1047].forEach((f, i) => tone(ctx, out, f, i * 0.08, 0.35, "triangle", 0.14));
        break;
      case "hint":
        tone(ctx, out, 1320, 0, 0.12, "sine", 0.08);
        tone(ctx, out, 1760, 0.06, 0.16, "sine", 0.08);
        break;
    }
  },
};

/** A pack backed by audio files, e.g. filePack("wood", "Wood", "/sounds/wood") -> /sounds/wood/move.mp3 */
export function filePack(id: string, name: string, folder: string, ext = "mp3"): SoundPack {
  const buffers = new Map<SoundEvent, Promise<AudioBuffer | null>>();
  return {
    id,
    name,
    play(event, ctx, out) {
      if (!buffers.has(event)) {
        buffers.set(
          event,
          fetch(`${folder}/${event}.${ext}`)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
            .then((b) => ctx.decodeAudioData(b))
            .catch(() => null),
        );
      }
      buffers.get(event)!.then((buf) => {
        if (!buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        src.start();
      });
    },
  };
}

// ---- Arcade: recorded wood/glass samples ----

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

  constructor(public pack: SoundPack = synthPack) {}

  setPack(pack: SoundPack) {
    this.pack = pack;
    if (pack.preload) pack.preload(this.context());
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
