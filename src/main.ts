import { api, type Profile } from "./api";
import { Board } from "./board";
import { CBURNETT, type PieceType } from "./pieces";
import { PuzzleSession, type SessionState, type Snapshot } from "./puzzle";
import { ANIMATION_SPEEDS, BOARD_THEMES, STYLES, loadSettings, saveSetting, type Settings } from "./settings";
import { arcadePack, Sounds, synthPack } from "./sounds";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const THEME_LABELS: Record<string, string> = {
  oneMove: "One move",
  short: "Short (2 moves)",
  long: "Long (3 moves)",
  veryLong: "Very long (4+ moves)",
  crushing: "Crushing",
  advantage: "Advantage",
  equality: "Equality",
  hangingPiece: "Hanging piece",
  enPassant: "En passant",
  backRankMate: "Back rank mate",
  smotheredMate: "Smothered mate",
  doubleCheck: "Double check",
  xRayAttack: "X-ray attack",
  zugzwang: "Zugzwang",
};

function themeLabel(name: string) {
  if (THEME_LABELS[name]) return THEME_LABELS[name];
  const words = name.replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

/** Key in the settings table holding the in-progress puzzle (a Snapshot as JSON, "" when none). */
const RESUME_KEY = "resume";

/**
 * Pause between a solved puzzle's ending finishing (last move landed, king fallen,
 * arcade board crumbled) and the next puzzle starting. Settings → "Go to next puzzle after solving".
 */
const AUTO_NEXT_DELAY_MS = 1000;
/** Arcade moves are a bit slower than Classic so the arc reads. */
const ARCADE_SPEED = 1.4;

const STATUS_TEXT:Record<SessionState["status"], (s: SessionState) => [string, string]> = {
  intro: () => ["", "Get ready…"],
  "your-turn": (s) =>
    s.mistakes > 0 && s.hintLevel === 0
      ? ["wrong", "Not quite — try again"]
      : ["turn", `Find the best move for ${s.playerColor === "w" ? "White" : "Black"}`],
  correct: () => ["good", "Best move! Keep going"],
  wrong: () => ["wrong", "That's not the move"],
  solved: (s) => ["good", s.clean ? "Solved!" : "Solved (with help)"],
  solution: () => ["info", "Here's the solution"],
};

class App {
  private settings!: Settings;
  private sounds = new Sounds();
  private board!: Board;
  private session: PuzzleSession | null = null;
  private profile: Profile | null = null;
  private lastDelta: number | null = null;
  private shownRating: number | null = null;
  private ratingFrame = 0;
  private arcadeSounds = arcadePack();
  private autoNextTimer: number | undefined;
  private savedSnapshot = "";

  async init() {
    this.settings = await loadSettings();
    this.board = new Board($("board"), CBURNETT, (from, to, promo) =>
      this.session?.handleMove(from, to, promo),
    );
    this.board.onPickup = (code) => this.sounds.play("pickup", { piece: code[1] as PieceType });
    this.applySettings();
    this.buildSettingsDialog();
    this.bindControls();
    await this.refreshProfile();
    if (!(await this.resumePuzzle())) await this.nextPuzzle();
  }

  /** Reopens the puzzle that was in progress when the app last closed. */
  private async resumePuzzle(): Promise<boolean> {
    let snap: Snapshot;
    try {
      const raw = (await api.getSettings())[RESUME_KEY];
      if (!raw) return false;
      snap = JSON.parse(raw);
    } catch {
      return false;
    }
    const puzzle = await api.getPuzzle(snap.puzzleId);
    if (!puzzle) return false; // e.g. no longer in a rebuilt puzzle set
    this.savedSnapshot = JSON.stringify(snap);
    if (this.settings.devMode) {
      this.startSession(new PuzzleSession(puzzle, this.board, this.sounds, this.hooks(), false, true));
    } else {
      this.startSession(new PuzzleSession(puzzle, this.board, this.sounds, this.hooks(), snap.reported), snap);
    }
    return true;
  }

  /** Saves progress after every change, so closing the app at any point loses nothing. */
  private saveProgress() {
    if (this.session?.dev) return; // dev mode leaves your real progress alone
    const snap = this.session?.snapshot();
    const json = snap ? JSON.stringify(snap) : "";
    if (json === this.savedSnapshot) return;
    this.savedSnapshot = json;
    api.setSetting(RESUME_KEY, json).catch((e) => console.error("saving progress failed", e));
  }

  private get arcade() {
    return this.settings.style === "arcade";
  }

  private animMs() {
    const ms = ANIMATION_SPEEDS.find((a) => a.id === this.settings.animation)?.ms ?? 200;
    return this.arcade ? Math.round(ms * ARCADE_SPEED) : ms;
  }

  private applySettings() {
    const s = this.settings;
    const theme =
      s.boardTheme === "custom"
        ? { light: s.customLight, dark: s.customDark }
        : (BOARD_THEMES.find((t) => t.id === s.boardTheme) ?? BOARD_THEMES[0]);
    document.documentElement.style.setProperty("--sq-light", theme.light);
    document.documentElement.style.setProperty("--sq-dark", theme.dark);
    this.board.setOptions({
      animMs: this.animMs(),
      showLegal: s.showLegal,
      showCoords: s.showCoords,
      clickToMove: s.clickToMove,
      arcade: this.arcade,
    });
    const pack = this.arcade ? this.arcadeSounds : synthPack;
    if (this.sounds.pack !== pack) this.sounds.setPack(pack);
    this.sounds.enabled = s.sound;
    this.sounds.volume = s.volume;
  }

  private async update<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings[key] = value;
    this.applySettings();
    await saveSetting(key, value);
  }

  // ---- puzzles ----

  private async nextPuzzle() {
    // Any theme, aimed at the player's own rating.
    const puzzle = await api.nextPuzzle(null, 0, this.session?.puzzle.id ?? null);
    if (!puzzle) {
      this.setStatus("info", "No puzzles found.");
      return;
    }
    this.startSession(new PuzzleSession(puzzle, this.board, this.sounds, this.hooks(), false, this.settings.devMode));
  }

  private retry() {
    if (!this.session) return;
    const { puzzle, dev } = this.session;
    this.startSession(new PuzzleSession(puzzle, this.board, this.sounds, this.hooks(), !dev, dev));
  }

  private startSession(session: PuzzleSession, resume?: Snapshot) {
    window.clearTimeout(this.autoNextTimer);
    this.session?.dispose();
    this.session = session;
    this.lastDelta = null;
    this.renderRating();
    session.start(resume);
  }

  private hooks() {
    return {
      onChange: (s: SessionState) => this.renderSession(s),
      onResult: async (r: { rated: boolean; ratingBefore: number; ratingAfter: number }) => {
        if (r.rated) this.lastDelta = Math.round(r.ratingAfter) - Math.round(r.ratingBefore);
        await this.refreshProfile();
      },
      timing: () => ({ animMs: this.animMs() }),
      kingGlow: () => this.settings.kingGlow,
      onFinished: () => {
        if (!this.settings.autoNext) return;
        window.clearTimeout(this.autoNextTimer);
        // After an arcade crumble the board is already gone, so the next one builds straight away.
        const delay = this.arcade && this.session?.state.mate ? 0 : AUTO_NEXT_DELAY_MS;
        this.autoNextTimer = window.setTimeout(() => this.nextPuzzle(), delay);
      },
    };
  }

  private renderSession(s: SessionState) {
    this.saveProgress();
    const [kind, text] =
      this.session?.dev && s.status !== "intro"
        ? s.mate
          ? ["good", "Checkmate! Reset the board to play again"]
          : ["info", "Dev mode: move either side"]
        : STATUS_TEXT[s.status](s);
    this.setStatus(kind, text);
    $("puzzle-id").textContent = `Puzzle #${s.puzzle.id}`;
    const turnKing = $("turn-swatch");
    turnKing.className = `swatch ${s.playerColor}`;
    turnKing.style.backgroundImage = CBURNETT.url(s.playerColor, "k");

    const themes = $("puzzle-themes");
    themes.innerHTML = "";
    if (s.done) {
      for (const t of s.puzzle.themes) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = themeLabel(t);
        themes.append(chip);
      }
    }

    const playing = !s.done;
    $<HTMLButtonElement>("btn-hint").disabled = !playing || s.status !== "your-turn" || s.hintLevel >= 2;
    $("btn-hint").textContent = s.hintLevel === 0 ? "Hint" : s.hintLevel === 1 ? "Show move" : "Hint used";
    const dev = !!this.session?.dev;
    $("btn-hint").hidden = s.done || dev;
    $("btn-retry").hidden = !s.done && !dev;
    $("btn-retry").textContent = dev ? "Reset board" : "Retry";
    $("btn-next").classList.toggle("primary", s.done);

    if (s.status === "solved" && this.settings.autoNext) {
      $("status-text").textContent += " Next puzzle coming up…";
    }
  }

  private setStatus(kind: string, text: string) {
    const el = $("status");
    el.className = `status ${kind}`;
    $("status-text").textContent = text;
  }

  private async refreshProfile() {
    this.profile = await api.getProfile();
    this.renderRating();
  }

  private renderRating() {
    const p = this.profile;
    if (!p) return;
    const rating = Math.round(p.rating);
    if (this.arcade && this.shownRating !== null && this.shownRating !== rating) {
      this.countRating(this.shownRating, rating);
    } else if (this.shownRating !== rating) {
      cancelAnimationFrame(this.ratingFrame);
      $("rating").textContent = String(rating);
    }
    this.shownRating = rating;
    $("rating").title = `±${Math.round(p.rd * 2)} (95% confidence)`;
    const delta = $("rating-delta");
    delta.hidden = this.lastDelta === null;
    if (this.lastDelta !== null) {
      delta.textContent = (this.lastDelta >= 0 ? "+" : "") + this.lastDelta;
      delta.className = `delta ${this.lastDelta >= 0 ? "up" : "down"}`;
    }
  }

  /** Arcade: rolls the rating from `from` to `to`, ticking as it goes (pitch rises or falls). */
  private countRating(from: number, to: number) {
    cancelAnimationFrame(this.ratingFrame);
    const el = $("rating");
    const duration = Math.min(1100, Math.max(450, 300 + Math.abs(to - from) * 6));
    const start = performance.now();
    const dir = Math.sign(to - from);
    let shown = from;
    let ticks = 0;
    let lastTick = 0;
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const value = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      if (value !== shown) {
        shown = value;
        el.textContent = String(value);
        if (now - lastTick > 45) {
          this.sounds.play("tick", { step: dir * ticks++ });
          lastTick = now;
        }
      }
      if (t < 1) this.ratingFrame = requestAnimationFrame(frame);
    };
    this.ratingFrame = requestAnimationFrame(frame);
  }

  // ---- controls ----

  private bindControls() {
    $("btn-hint").addEventListener("click", () => this.session?.hint());
    $("btn-retry").addEventListener("click", () => this.retry());
    $("btn-next").addEventListener("click", () => this.nextPuzzle());
    $("btn-settings").addEventListener("click", () => $<HTMLDialogElement>("settings").showModal());
    $("btn-close-settings").addEventListener("click", () => $<HTMLDialogElement>("settings").close());

    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ($<HTMLDialogElement>("settings").open || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "h") this.session?.hint();
      else if (key === "n" || (key === "enter" && this.session?.state.done)) this.nextPuzzle();
      else if (key === "r" && this.session?.state.done) this.retry();
    });
  }

  private buildSettingsDialog() {
    const boardThemes = $("opt-board-theme");
    const light = $<HTMLInputElement>("opt-light");
    const dark = $<HTMLInputElement>("opt-dark");
    const showColors = () => {
      const s = this.settings;
      const t = BOARD_THEMES.find((x) => x.id === s.boardTheme);
      light.value = t?.light ?? s.customLight;
      dark.value = t?.dark ?? s.customDark;
    };
    showColors();
    // While a color is being picked, the dialog moves over the side panel and the
    // backdrop stops dimming, so the whole board stays in view.
    const dialog = $<HTMLDialogElement>("settings");
    const dock = (on: boolean) => {
      if (on) {
        const panel = document.querySelector(".panel")!.getBoundingClientRect();
        const board = document.querySelector(".board")!.getBoundingClientRect();
        dialog.style.setProperty("--dock-left", `${panel.left}px`);
        dialog.style.setProperty("--dock-top", `${board.top}px`);
        dialog.style.setProperty("--dock-width", `${panel.width}px`);
        dialog.style.setProperty("--dock-height", `${board.height}px`);
      }
      dialog.classList.toggle("docked", on);
    };
    dialog.addEventListener("close", () => dock(false));
    // Clicking or tabbing to anything else in the dialog ends color editing.
    const isPicker = (t: EventTarget | null) => t === light || t === dark;
    dialog.addEventListener("pointerdown", (e) => !isPicker(e.target) && dock(false));
    dialog.addEventListener("focusin", (e) => !isPicker(e.target) && dock(false));
    // Picking a color switches to a custom board, starting from the colors on screen.
    for (const input of [light, dark]) {
      // Click, not just focus: WebKit (the macOS app) doesn't focus color inputs on click.
      input.addEventListener("click", () => dock(true));
      input.addEventListener("focus", () => dock(true));
      input.addEventListener("input", () => {
        boardThemes.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        this.settings.customLight = light.value;
        this.settings.customDark = dark.value;
        this.settings.boardTheme = "custom";
        this.applySettings();
      });
      input.addEventListener("change", async () => {
        await saveSetting("customLight", light.value);
        await saveSetting("customDark", dark.value);
        await this.update("boardTheme", "custom");
      });
    }
    for (const t of BOARD_THEMES) {
      const btn = document.createElement("button");
      btn.className = "theme-swatch";
      btn.title = t.name;
      btn.style.background = `conic-gradient(${t.dark} 0 25%, ${t.light} 0 50%, ${t.dark} 0 75%, ${t.light} 0)`;
      btn.setAttribute("aria-pressed", String(t.id === this.settings.boardTheme));
      btn.addEventListener("click", () => {
        boardThemes.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        btn.setAttribute("aria-pressed", "true");
        void this.update("boardTheme", t.id);
        showColors();
      });
      boardThemes.append(btn);
    }

    const style = $<HTMLSelectElement>("opt-style");
    fillSelect(style, STYLES, this.settings.style);
    style.addEventListener("change", () => this.update("style", style.value));

    const anim = $<HTMLSelectElement>("opt-animation");
    fillSelect(anim, ANIMATION_SPEEDS, this.settings.animation);
    anim.addEventListener("change", () => this.update("animation", anim.value));

    const checks: [string, "sound" | "showLegal" | "showCoords" | "clickToMove" | "autoNext" | "kingGlow" | "devMode"][] = [
      ["opt-sound", "sound"],
      ["opt-legal", "showLegal"],
      ["opt-coords", "showCoords"],
      ["opt-clickmove", "clickToMove"],
      ["opt-autonext", "autoNext"],
      ["opt-kingglow", "kingGlow"],
      ["opt-devmode", "devMode"],
    ];
    for (const [id, key] of checks) {
      const box = $<HTMLInputElement>(id);
      box.checked = this.settings[key];
      box.addEventListener("change", async () => {
        await this.update(key, box.checked);
        // Switching dev mode restarts the current puzzle in the new mode.
        if (key === "devMode" && this.session) {
          this.startSession(
            new PuzzleSession(this.session.puzzle, this.board, this.sounds, this.hooks(), false, box.checked),
          );
        }
      });
    }

    const volume = $<HTMLInputElement>("opt-volume");
    volume.value = String(this.settings.volume);
    volume.addEventListener("input", () => {
      this.settings.volume = Number(volume.value);
      this.sounds.volume = this.settings.volume;
    });
    volume.addEventListener("change", () => {
      void this.update("volume", Number(volume.value));
      this.sounds.play("move");
    });
  }
}

function fillSelect(select: HTMLSelectElement, items: { id: string; name: string }[], value: string) {
  select.innerHTML = "";
  for (const item of items) select.append(new Option(item.name, item.id));
  select.value = value;
}

new App().init().catch((e) => {
  console.error(e);
  document.body.textContent = `Failed to start: ${e}`;
});
