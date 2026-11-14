import { Chess } from "chess.js";
import { api, type AttemptResult, type Profile, type Puzzle } from "./api";
import { Board, TACTIC_ICONS, TACTIC_NAMES } from "./board";
import { BOT_LEVELS, GameSession, levelName, START_FEN, type GameResult, type GameSave, type GameState } from "./game";
import { PIECE_SETS, pieceSetById, type PieceColor, type PieceType } from "./pieces";
import { PuzzleSession, type SessionState, type Snapshot } from "./puzzle";
import { ANIMATION_SPEEDS, loadSettings, saveSetting, type Settings } from "./settings";
import { arcadePack, Sounds } from "./sounds";
import { formatEval, QUALITY_NAME, QUALITY_SYMBOL, winChance } from "./quality";
import { decodeGames, encodeGames } from "./gamecode";
import { accuracyOf, add, gameTotals, StatsStore, summarize, sum, type Counts, type GameRecord } from "./stats";
import type { Tactic, TacticLogEntry } from "./tactics";

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
/** Key in the settings table holding the game in progress against the bot (a GameSave as JSON, "" when none). */
const GAME_KEY = "game";

const COLOR_CHOICES = [
  { id: "w", name: "White" },
  { id: "random", name: "Random" },
  { id: "b", name: "Black" },
];

const RESULT_TEXT: Record<string, string> = {
  stalemate: "Draw by stalemate",
  repetition: "Draw by repetition",
  "insufficient material": "Draw: not enough material to mate",
  "50-move rule": "Draw by the 50-move rule",
};

/**
 * Pause between a solved puzzle's ending finishing (last move landed, king fallen,
 * arcade board crumbled) and the next puzzle starting. Settings → "Go to next puzzle after solving".
 */
const AUTO_NEXT_DELAY_MS = 1000;
/** The single "+" of the check badge (24x24). */
const CHECK_ICON = '<path d="M10.6 4.5h2.8v6.1h6.1v2.8h-6.1v6.1h-2.8v-6.1H4.5v-2.8h6.1z" fill="currentColor"/>';
/** The Tactical info card under the board (what each tactic badge means). Hidden for now; it still renders. */
const SHOW_TACTICAL_INFO = false;

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
  private sounds = new Sounds(arcadePack());
  private board!: Board;
  private session: PuzzleSession | null = null;
  private profile: Profile | null = null;
  private lastDelta: number | null = null;
  private shownRating: number | null = null;
  private ratingFrame = 0;
  private autoNextTimer: number | undefined;
  private savedSnapshot = "";
  private game: GameSession | null = null;
  private copyNoteTimer = 0;
  private gameOverTimer = 0;
  private gameOverDetail = "";
  /** Game, move count and shown move the move list was last scrolled for. */
  private moveListKey = "";
  private savedGame = "";
  private stats = new StatsStore();
  /** A finished game opened from the stats page; the game in progress (if any) waits, saved. */
  private reviewing = false;
  /** Which half of the stats page is showing; starts on the current mode's. */
  private statsView: "bot" | "puzzles" | null = null;

  async init() {
    this.settings = await loadSettings();
    await this.stats.load();
    this.board = new Board($("board"), pieceSetById(this.settings.pieceSet), (from, to, promo) =>
      this.settings.mode === "play" ? this.game?.handleMove(from, to, promo) : this.session?.handleMove(from, to, promo),
    );
    this.board.onPickup = (code) => this.sounds.play("pickup", { piece: code[1] as PieceType });
    this.applySettings();
    this.sounds.preload();
    this.buildSettingsDialog();
    this.buildPlaySetup();
    this.bindControls();
    await this.refreshProfile();
    await this.showMode(this.settings.mode === "play" ? "play" : "puzzles");
  }

  // ---- modes ----

  /** Switches between puzzles and playing the bot. Each side picks up where it left off. */
  private async showMode(mode: "puzzles" | "play") {
    if (mode !== this.settings.mode) void this.update("mode", mode);
    $("tab-puzzles").setAttribute("aria-selected", String(mode === "puzzles"));
    $("tab-play").setAttribute("aria-selected", String(mode === "play"));
    $("puzzle-panel").hidden = mode !== "puzzles";
    $("play-panel").hidden = mode !== "play";
    this.board.setMarkSlot(mode === "puzzles");
    this.renderEvalBar(mode === "play" ? (this.game?.state ?? null) : null);
    // The Tactical info card is shared; show this mode's.
    if (mode === "puzzles") this.renderTacticLog(this.session?.state.tacticLog ?? [], Infinity);
    else this.renderTacticLog(this.game?.state.tacticLog ?? [], this.game?.state.viewing ?? Infinity, (ply) => this.game?.browse(ply));
    window.clearTimeout(this.autoNextTimer);
    if (mode === "puzzles") {
      this.game?.dispose();
      this.game = null;
      if (this.reviewing) this.reviewing = false; // a reviewed game just closes; the game in progress stays saved
      if (!this.session && !(await this.resumePuzzle())) await this.nextPuzzle();
    } else {
      // Puzzle progress is already saved after every change.
      this.session?.dispose();
      this.session = null;
      if (!this.game && !(await this.resumeGame())) this.showSetup();
    }
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

  /** Animation Off turns off all the arcade effects too (flat pieces, no build/crumble, no rating roll). */
  private get arcade() {
    return this.animMs() > 0;
  }

  /** Fancy animation: pieces bounce, and the board builds and crumbles. */
  private get fancy() {
    return this.settings.animation === "fancy";
  }

  private animMs() {
    return ANIMATION_SPEEDS.find((a) => a.id === this.settings.animation)?.ms ?? 200;
  }

  private applySettings() {
    const s = this.settings;
    const pieces = pieceSetById(s.pieceSet);
    this.board.setPieceSet(pieces);
    if (this.session) $("turn-swatch").style.backgroundImage = pieces.url(this.session.state.playerColor, "k");
    if (this.game) this.renderGame(this.game.state);
    this.board.setOptions({
      animMs: this.animMs(),
      showLegal: s.showLegal,
      showCoords: s.showCoords,
      clickToMove: s.clickToMove,
      arcade: this.arcade,
      fancy: this.fancy,
      tacticHighlight: s.tacticHighlight,
      tacticArrows: s.tacticArrows,
    });
    this.sounds.enabled = s.sound;
    this.sounds.volume = s.volume;
    document.querySelector(".app")?.classList.toggle("dev", s.devMode);
    const tacticalInfo = SHOW_TACTICAL_INFO && s.showTactics;
    $("tactics-card").hidden = !tacticalInfo;
    document.querySelector(".app")?.classList.toggle("tactics", tacticalInfo);
    if (this.session) this.renderSession(this.session.state);
    $("dev-bar").hidden = !s.devMode;
  }

  /**
   * Tactical info (under the board): one row per tactic of the player's moves,
   * newest first, e.g. "21 Qd1+  [queen] (pin) [bishop] [rook]". The move on
   * screen (`shownPly`, e.g. while browsing history) is highlighted.
   */
  private renderTacticLog(log: TacticLogEntry[], shownPly: number, onPick?: (ply: number) => void) {
    const list = $("tactics-log");
    list.innerHTML = "";
    const set = pieceSetById(this.settings.pieceSet);
    const piece = (code: string) => {
      const span = document.createElement("span");
      span.className = "feed-piece";
      span.style.backgroundImage = set.url(code[0] as PieceColor, code[1] as PieceType);
      span.setAttribute("role", "img");
      span.setAttribute("aria-label", code);
      return span;
    };
    const entries = [...log].reverse();
    for (const entry of entries) {
      for (const d of entry.details) {
        const row = document.createElement("li");
        row.className = `feed-entry ${d.kind}${entry.enemy ? " enemy" : ""}`;
        row.classList.toggle("current", entry.ply === shownPly);
        const label = document.createElement("span");
        label.className = "feed-move";
        label.textContent = entry.label.replace(/[.…]/, "");
        const icon = document.createElement("span");
        icon.className = `feed-icon ${d.kind}${entry.enemy ? " enemy" : ""}`;
        icon.title = TACTIC_NAMES[d.kind];
        icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TACTIC_ICONS[d.kind]}</svg>`;
        row.append(label, ...d.by.map(piece), icon, ...d.targets.map(piece));
        if (onPick) row.addEventListener("click", () => onPick(entry.ply));
        list.append(row);
      }
    }
    list.classList.toggle("empty", entries.length === 0);
    // Keep the highlighted row in view (scrolling only the list).
    const current = list.querySelector<HTMLElement>(".current");
    if (!current) list.scrollTop = 0;
    else if (current.offsetTop - list.offsetTop < list.scrollTop || current.offsetTop - list.offsetTop + current.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = current.offsetTop - list.offsetTop;
    // The newest entry slides in when it first appears.
    const top = entries[0]?.ply ?? 0;
    if (top > Number(list.dataset.top ?? 0) && this.animMs() > 0) {
      list.querySelectorAll(`.feed-entry`).forEach((row, i) => i < entries[0].details.length && row.classList.add("fresh"));
    }
    list.dataset.top = String(top);
  }

  /** Dev: copies everything about the current game/puzzle and board as JSON, to paste into a bug report. */
  private async copyState() {
    const { mode, showTactics, animation, clickToMove, showLegal } = this.settings;
    const state = {
      copied: new Date().toISOString(),
      mode,
      settings: { showTactics, animation, clickToMove, showLegal },
      ...(mode === "play" ? { game: this.game?.debugState() ?? null } : { puzzle: this.session?.debugState() ?? null }),
      board: this.board.debugState(),
    };
    await copyText(JSON.stringify(state, null, 2));
    this.flashNote("copy-note", "Copied");
  }

  /** Shows `text` in the note element `id` for a moment. */
  private flashNote(id: string, text: string, ms = 1500) {
    const note = $(id);
    note.textContent = text;
    window.clearTimeout(this.copyNoteTimer);
    this.copyNoteTimer = window.setTimeout(() => (note.textContent = ""), ms);
  }

  /** Adds the games in the pasted codes to the history (skipping ones already there). */
  private importGames() {
    const area = $<HTMLTextAreaElement>("import-codes");
    let decoded;
    try {
      decoded = decodeGames(area.value);
    } catch (e) {
      this.flashNote("games-note", (e as Error).message, 4000);
      return;
    }
    if (!decoded.length) {
      this.flashNote("games-note", "Paste a game code first", 3000);
      return;
    }
    const key = (date: string, moves: string[]) => `${date.slice(0, 16)}|${moves.join(" ")}`;
    const have = new Set(this.stats.archive.map((g) => key(g.date, g.moves)));
    let added = 0;
    const records: GameRecord[] = [];
    for (const d of decoded) {
      if (have.has(key(d.date, d.moves))) continue;
      const chess = new Chess(d.fen);
      for (const uci of d.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      records.push({
        id: `imp-${Date.now().toString(36)}-${added}`,
        date: d.date,
        fen: d.fen,
        moves: d.moves,
        playerColor: d.playerColor,
        level: d.level,
        result: d.result,
        summary: summarize(chess.history({ verbose: true }), d.playerColor, d.takebacks),
      });
      have.add(key(d.date, d.moves));
      added++;
    }
    if (records.length) this.stats.addGames(records);
    const skipped = decoded.length - added;
    area.value = "";
    this.renderGames();
    this.flashNote(
      "games-note",
      `Imported ${added} game${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already here)` : ""}`,
      4000,
    );
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
      onResult: async (r: AttemptResult, attempt: { solved: boolean; hinted: boolean; puzzle: Puzzle }) => {
        if (r.rated) this.lastDelta = Math.round(r.ratingAfter) - Math.round(r.ratingBefore);
        await this.refreshProfile();
        if (r.rated) this.recordPuzzle(r, attempt);
      },
      onTactics: (kinds: Tactic[]) => this.stats.updatePuzzles((s) => kinds.forEach((k) => add(s.tactics, k))),
      timing: () => ({ animMs: this.animMs() }),
      kingGlow: () => this.settings.kingGlow,
      tactics: () => this.settings.showTactics,
      enemyTactics: () => this.settings.enemyTactics,
      onFinished: () => {
        if (!this.settings.autoNext || this.settings.mode !== "puzzles") return;
        window.clearTimeout(this.autoNextTimer);
        // After a crumble (Fancy) the board is already gone, so the next one builds straight away.
        const delay = this.fancy && this.session?.state.mate ? 0 : AUTO_NEXT_DELAY_MS;
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
    if (this.settings.mode === "puzzles") this.renderTacticLog(s.tacticLog, Infinity);
    const turnKing = $("turn-swatch");
    turnKing.className = `swatch ${s.playerColor}`;
    turnKing.style.backgroundImage = pieceSetById(this.settings.pieceSet).url(s.playerColor, "k");

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

  // ---- playing the bot ----

  private async resumeGame(): Promise<boolean> {
    let save: GameSave;
    try {
      const raw = (await api.getSettings())[GAME_KEY];
      if (!raw) return false;
      save = JSON.parse(raw);
    } catch {
      return false;
    }
    this.savedGame = JSON.stringify(save);
    try {
      this.startGame(save, false);
    } catch (e) {
      console.error("couldn't resume game", e);
      return false;
    }
    return true;
  }

  /**
   * A second after a bot game ends (once a checkmated king has fallen), a popup
   * with the result and a New game button.
   */
  private announceResult(g: GameRecord) {
    window.clearTimeout(this.gameOverTimer);
    const delay = 1000 + (g.result.reason === "checkmate" ? this.animMs() : 0);
    this.gameOverTimer = window.setTimeout(() => {
      if (this.settings.mode !== "play" || this.reviewing) return;
      const r = g.result;
      const won = r.winner === g.playerColor;
      const title = r.winner === null ? "Draw" : won ? "You won" : "You lost";
      const how =
        r.winner === null
          ? (RESULT_TEXT[r.reason] ?? "Draw").replace(/^Draw:?\s*/, "")
          : r.reason === "resignation"
            ? won
              ? "by resignation"
              : "You resigned"
            : `by ${r.reason}`;
      const dialog = $<HTMLDialogElement>("game-over");
      dialog.className = `game-over ${r.winner === null ? "draw" : won ? "won" : "lost"}`;
      $("game-over-title").textContent = title;
      this.gameOverDetail = `${how[0].toUpperCase()}${how.slice(1)} · ${levelName(g.level)} bot · ${g.summary.moves} moves`;
      this.renderGameOverDetail(this.game?.state ?? null);
      dialog.showModal();
      $("btn-over-new").focus();
    }, delay);
  }

  /** The game-over popup's details line, with the accuracy once grading has finished. */
  private renderGameOverDetail(s: GameState | null) {
    $("game-over-detail").textContent = this.gameOverDetail;
    const you = s?.accuracy ?? null;
    const bot = s?.botAccuracy ?? null;
    $("game-over-accuracy").textContent =
      you === null ? "Accuracy: grading…" : `Accuracy: you ${Math.round(you)}%${bot === null ? "" : ` · bot ${Math.round(bot)}%`}`;
  }

  /** Puzzle totals for the stats page, after a rated attempt. */
  private recordPuzzle(r: AttemptResult, attempt: { solved: boolean; hinted: boolean; puzzle: Puzzle }) {
    const win = attempt.solved && !attempt.hinted;
    this.stats.updatePuzzles((s) => {
      s.attempted++;
      if (attempt.hinted) s.hintsUsed++;
      s.peakRating = Math.max(s.peakRating, Math.round(r.ratingAfter));
      if (win) {
        s.solved++;
        s.solvedRatingSum += attempt.puzzle.rating;
        s.hardestSolved = Math.max(s.hardestSolved, attempt.puzzle.rating);
        for (const t of attempt.puzzle.themes) add(s.themes, t);
      }
      s.bestStreak = Math.max(s.bestStreak, this.profile?.streak ?? 0);
    });
  }

  private startGame(save: GameSave, fresh: boolean, review: GameResult | null = null) {
    this.game?.dispose();
    this.reviewing = !!review;
    this.game = new GameSession(
      save,
      this.board,
      this.sounds,
      {
        onChange: (s) => this.renderGame(s),
        // A reviewed game is look-only; the game in progress stays saved as it was.
        onSave: (s) => !review && this.saveGame(s),
        timing: () => ({ animMs: this.animMs() }),
        tactics: () => this.settings.showTactics,
        enemyTactics: () => this.settings.enemyTactics,
        quality: () => this.settings.showQuality,
        fairLive: () => this.settings.fairLive,
        onGameOver: (record) => {
          // Later calls just update the saved game (engine grades coming in); only a new ending gets the popup.
          const fresh = !this.stats.archive.some((g) => g.id === record.id);
          this.stats.saveGame(record);
          if (fresh && !review) this.announceResult(record);
        },
        onGameReopened: (id) => {
          this.stats.unsaveGame(id);
          window.clearTimeout(this.gameOverTimer);
          $<HTMLDialogElement>("game-over").close();
        },
      },
      review,
    );
    $("play-setup").hidden = true;
    $("play-game").hidden = false;
    this.game.start(fresh);
  }

  private saveGame(save: GameSave | null) {
    const json = save ? JSON.stringify(save) : "";
    if (json === this.savedGame) return;
    this.savedGame = json;
    api.setSetting(GAME_KEY, json).catch((e) => console.error("saving game failed", e));
  }

  /** The level/color picker, with the starting position on the board. */
  private showSetup() {
    this.game?.dispose();
    this.game = null;
    $("play-setup").hidden = false;
    $("play-game").hidden = true;
    this.renderTacticLog([], 0);
    this.renderEvalBar(null);
    this.board.setMovable(null);
    this.board.setArrow(null);
    this.board.setHighlights({});
    this.board.setOrientation(this.settings.botColor === "b" ? "b" : "w");
    this.board.setPosition(startPosition());
  }

  private buildPlaySetup() {
    const levels = $("level-choices");
    const levelLabel = $("level-name");
    const showLevel = () => {
      levelLabel.textContent = levelName(this.settings.botLevel);
      for (const b of levels.children) b.setAttribute("aria-checked", String((b as HTMLElement).dataset.id === String(this.settings.botLevel)));
    };
    for (const l of BOT_LEVELS) {
      const btn = segButton(String(l.level), String(l.level), l.name);
      btn.addEventListener("click", () => {
        void this.update("botLevel", l.level);
        showLevel();
      });
      levels.append(btn);
    }
    showLevel();

    const colors = $("color-choices");
    const showColor = () => {
      for (const b of colors.children) b.setAttribute("aria-checked", String((b as HTMLElement).dataset.id === this.settings.botColor));
    };
    for (const c of COLOR_CHOICES) {
      const btn = segButton(c.id, c.name, `Play as ${c.name.toLowerCase()}`);
      btn.addEventListener("click", () => {
        void this.update("botColor", c.id);
        showColor();
        if (!this.game) this.board.flipTo(c.id === "b" ? "b" : "w");
      });
      colors.append(btn);
    }
    showColor();

    $("btn-start-game").addEventListener("click", () => {
      const pick = this.settings.botColor;
      const playerColor = pick === "random" ? (Math.random() < 0.5 ? "w" : "b") : pick === "b" ? "b" : "w";
      this.startGame({ fen: START_FEN, moves: [], playerColor, level: this.settings.botLevel }, true);
    });
  }

  /** The evaluation bar beside the board (bot games): White's share from its own side, the score at the leading end. */
  private renderEvalBar(s: GameState | null) {
    const bar = $("eval-bar");
    // Hidden during a fair live review (it's engine help); back once the game ends.
    const show = !!s && s.fullReview && this.settings.evalBar && this.settings.mode === "play";
    bar.hidden = !show;
    document.querySelector(".app")?.classList.toggle("evalbar", show);
    if (!s || !show) return;
    bar.classList.toggle("flipped", s.playerColor === "b");
    if (s.evalCp === null) return; // keep the last reading while the engine works
    const white = winChance(s.evalCp);
    $("eval-fill").style.height = `${white}%`;
    const num = $("eval-num");
    num.textContent = formatEval(s.evalCp).replace("+", "");
    num.classList.toggle("white-ahead", s.evalCp >= 0);
    bar.title = `${formatEval(s.evalCp)} · White ${Math.round(white)}% to win`;
  }

  private renderGame(s: GameState) {
    this.renderEvalBar(s);
    if ($<HTMLDialogElement>("game-over").open && !s.review) this.renderGameOverDetail(s);
    const you = s.playerColor === "w" ? "White" : "Black";
    $("bot-name").textContent = `${levelName(s.level)} bot · you play ${you}`;

    let kind: string;
    let text: string;
    const toMove = s.san.length % 2 === 0 ? "w" : "b";
    if (s.status === "thinking") {
      [kind, text] = ["info", "Bot is thinking…"];
    } else if (s.status === "your-turn") {
      const inCheck = s.san.at(-1)?.endsWith("+");
      [kind, text] = ["turn", inCheck ? "Your move: you're in check" : "Your move"];
    } else {
      const r = s.result!;
      if (r.winner === null) [kind, text] = ["info", RESULT_TEXT[r.reason] ?? "Draw"];
      else if (r.reason === "resignation") [kind, text] = ["wrong", "You resigned"];
      else if (r.winner === s.playerColor) [kind, text] = ["good", "Checkmate. You win!"];
      else [kind, text] = ["wrong", "Checkmate. The bot wins"];
    }
    if (s.viewing !== null) {
      kind = "info";
      text = s.viewing === 0 ? "Start position · → to step forward" : `Viewing move ${Math.ceil(s.viewing / 2)}${s.viewing % 2 ? "" : "…"} · End to return`;
    }
    $("game-status").className = `status ${kind}`;
    $("game-status-text").textContent = text;
    const swatchColor = s.status === "over" ? s.playerColor : toMove;
    const swatch = $("game-swatch");
    swatch.className = `swatch ${swatchColor}`;
    swatch.style.backgroundImage = pieceSetById(this.settings.pieceSet).url(swatchColor, "k");

    const list = $("move-list");
    const keptScroll = list.scrollTop; // rebuilding the list resets it
    list.innerHTML = "";
    for (let i = 0; i < s.san.length; i += 2) {
      const li = document.createElement("li");
      s.san.slice(i, i + 2).forEach((san, j) => {
        const span = document.createElement("span");
        span.textContent = san;
        const q = this.settings.showQuality ? s.quality[i + j] : null;
        if (q && QUALITY_SYMBOL[q]) {
          const mark = document.createElement("span");
          mark.className = `move-quality ${q}`;
          mark.textContent = QUALITY_SYMBOL[q];
          mark.title = QUALITY_NAME[q];
          span.append(mark);
        }
        const logged = s.tacticLog.find((e) => e.ply === i + j + 1);
        const kinds = [...new Set(logged?.details.map((d) => d.kind) ?? [])];
        // Checks (either side) get the red "+" like the king's badge; a double check already has its own.
        const check = /[+#]/.test(san) && !kinds.includes("double-check");
        if (kinds.length || check) {
          const badges = document.createElement("span");
          badges.className = "move-tactics";
          if (check) {
            const icon = document.createElement("span");
            icon.className = "feed-icon mini check";
            icon.title = san.endsWith("#") ? "Checkmate" : "Check";
            icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${CHECK_ICON}</svg>`;
            badges.append(icon);
          }
          for (const kind of kinds) {
            const icon = document.createElement("span");
            icon.className = `feed-icon mini ${kind}${logged?.enemy ? " enemy" : ""}`;
            icon.title = TACTIC_NAMES[kind];
            icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TACTIC_ICONS[kind]}</svg>`;
            badges.append(icon);
          }
          span.append(badges);
        }
        span.addEventListener("click", () => this.game?.browse(i + j + 1));
        li.append(span);
      });
      list.append(li);
    }
    const shown = s.viewing ?? s.san.length;
    const current = shown > 0 ? list.children[Math.floor((shown - 1) / 2)]?.children[(shown - 1) % 2] : undefined;
    current?.classList.add("latest");
    // Only scroll when a move was played or a different one is shown; other redraws
    // (e.g. engine grades coming in) leave the list where you scrolled it.
    const listKey = `${this.game?.id}|${s.san.length}|${shown}`;
    const moved = listKey !== this.moveListKey;
    this.moveListKey = listKey;
    if (!moved) list.scrollTop = keptScroll;
    else if (s.viewing === null) list.scrollTop = list.scrollHeight;
    else if (current instanceof HTMLElement) {
      // Scroll only the list (scrollIntoView would also scroll the page away from the board).
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + current.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + current.offsetHeight - list.clientHeight;
    }
    list.classList.toggle("empty", s.san.length === 0);
    if (this.settings.mode === "play") this.renderTacticLog(s.tacticLog, shown, (ply) => this.game?.browse(ply));

    const over = s.status === "over";
    $<HTMLButtonElement>("btn-takeback").disabled = !s.canTakeback;
    $("btn-takeback").hidden = s.review;
    $("btn-resign").hidden = over;
    $("btn-new-game").hidden = !over || s.review;
    $("btn-close-review").hidden = !s.review;
  }

  // ---- stats ----

  private openStats() {
    this.statsView ??= this.settings.mode === "play" ? "bot" : "puzzles";
    this.renderStats();
    $<HTMLDialogElement>("stats").showModal();
    $<HTMLDialogElement>("stats").scrollTop = 0;
  }

  private renderStats() {
    if (!this.statsView) return;
    const t = gameTotals(this.stats.archive);
    const p = this.stats.puzzles;
    const set = pieceSetById(this.settings.pieceSet);
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
    const stat = (label: string, value: string | number) =>
      `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
    const pieces = (counts: Counts, color: PieceColor) =>
      `<div class="stat-chips">${(["q", "r", "b", "n", "p"] as PieceType[])
        .map(
          (k) =>
            `<span class="stat-chip"><span class="stat-piece" style="background-image:${set.url(color, k).replace(/"/g, "'")}"></span>${counts[k] ?? 0}</span>`,
        )
        .join("")}</div>`;
    const tactics = (counts: Counts) =>
      `<div class="stat-chips">${(Object.keys(TACTIC_ICONS) as Tactic[])
        .map(
          (k) =>
            `<span class="stat-chip" title="${TACTIC_NAMES[k]}"><span class="feed-icon ${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${TACTIC_ICONS[k]}</svg></span>${counts[k] ?? 0}</span>`,
        )
        .join("")}</div>`;
    const me: PieceColor = "w";
    const them: PieceColor = "b";

    const levels = BOT_LEVELS.map((l) => {
      const r = t.byLevel.get(l.level);
      return r ? `<li><span>${l.name}</span><span>${r.w} W · ${r.l} L · ${r.d} D</span></li>` : "";
    }).join("");

    const topThemes = Object.entries(p.themes)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 6)
      .map(([name, n]) => `<span class="chip">${esc(themeLabel(name))} · ${n}</span>`)
      .join("");

    const prof = this.profile;
    const view = this.statsView;
    for (const btn of $("stats-view").children) btn.setAttribute("aria-checked", String((btn as HTMLElement).dataset.id === view));
    $("stats-body").innerHTML =
      view === "bot"
        ? `
      <h3>Results</h3>
      <div class="stat-grid">
        ${stat("Played", t.games)}${stat("Won", t.wins)}${stat("Lost", t.losses)}${stat("Drawn", t.draws)}
        ${stat("Win rate", pct(t.wins, t.games))}${stat("Win streak", t.winStreak)}${stat("Best win streak", t.bestWinStreak)}${stat("Checkmates", t.checkmatesGiven)}
        ${stat("Avg accuracy", t.accuracy === null ? "–" : `${Math.round(t.accuracy)}%`)}${stat("Best accuracy", t.bestAccuracy === null ? "–" : `${Math.round(t.bestAccuracy)}%`)}
        ${stat("Quickest win", t.quickestWin ? `${t.quickestWin} moves` : "–")}${stat("Longest game", t.longestGame ? `${t.longestGame} moves` : "–")}${stat("Resigned", t.resignations)}${stat("Takebacks", t.takebacks)}
      </div>
      ${levels ? `<ul class="stat-list">${levels}</ul>` : ""}
      <h3>Moves</h3>
      <div class="stat-grid">
        ${stat("Moves made", t.moves)}${stat("Checks given", t.checks)}${stat("Castles", t.castles)}${stat("Promotions", t.promotions)}
      </div>
      <div class="stat-row"><span class="stat-row-label">Captured (${sum(t.captured)})</span>${pieces(t.captured, them)}</div>
      <div class="stat-row"><span class="stat-row-label">Lost (${sum(t.lost)})</span>${pieces(t.lost, me)}</div>
      <h3>Move quality</h3>
      <div class="stat-grid">
        ${stat("Best moves", t.quality.best ?? 0)}${stat("Good moves", t.quality.good ?? 0)}${stat("Inaccuracies", t.quality.inaccuracy ?? 0)}${stat("Mistakes", t.quality.mistake ?? 0)}${stat("Blunders", t.quality.blunder ?? 0)}
      </div>
      <h3>Tactics</h3>
      <div class="stat-row"><span class="stat-row-label">Yours (${sum(t.tactics)})</span>${tactics(t.tactics)}</div>
      <div class="stat-row"><span class="stat-row-label">Used against you (${sum(t.enemyTactics)})</span>${tactics(t.enemyTactics)}</div>
`
        : `
      <h3>Rating</h3>
      <div class="stat-grid">
        ${stat("Rating", prof ? Math.round(prof.rating) : "–")}${stat("Peak rating", p.peakRating || "–")}${stat("Avg solved rating", p.solved ? Math.round(p.solvedRatingSum / p.solved) : "–")}${stat("Hardest solved", p.hardestSolved || "–")}
      </div>
      <h3>Solving</h3>
      <div class="stat-grid">
        ${stat("Solved", p.solved)}${stat("Attempted", p.attempted)}${stat("Accuracy", pct(p.solved, p.attempted))}${stat("Hints used", p.hintsUsed)}
        ${stat("Streak", prof?.streak ?? 0)}${stat("Best streak", p.bestStreak)}
      </div>
      <h3>Tactics</h3>
      <div class="stat-row"><span class="stat-row-label">Yours (${sum(p.tactics)})</span>${tactics(p.tactics)}</div>
      ${topThemes ? `<h3>Most solved themes</h3><div class="chips">${topThemes}</div>` : ""}`;

  }

  // ---- past games ----

  private openGames() {
    this.renderGames();
    $<HTMLDialogElement>("games").showModal();
    $<HTMLDialogElement>("games").scrollTop = 0;
  }

  /** Finished games against the computer, newest first; click one to look through it. */
  private renderGames() {
    const set = pieceSetById(this.settings.pieceSet);
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const result = (g: GameRecord) => {
      const r = g.result;
      if (r.winner === null) return `Draw (${r.reason})`;
      const won = r.winner === g.playerColor;
      return `${won ? "Won" : "Lost"} by ${r.reason}`;
    };
    const games = [...this.stats.archive]
      .reverse()
      .map((g) => {
        const date = new Date(g.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        const kinds = (Object.keys(g.summary.tactics) as Tactic[]).filter((k) => (g.summary.tactics[k] ?? 0) > 0);
        const icons = kinds
          .map((k) => `<span class="feed-icon mini ${k}" title="${TACTIC_NAMES[k]} ×${g.summary.tactics[k]}"><svg viewBox="0 0 24 24" aria-hidden="true">${TACTIC_ICONS[k]}</svg></span>`)
          .join("");
        const won = g.result.winner === g.playerColor;
        const kind = g.result.winner === null ? "draw" : won ? "won" : "lost";
        return `<li class="past-game ${kind}" data-id="${esc(g.id)}" tabindex="0">
          <span class="swatch ${g.playerColor}" style="background-image:${set.url(g.playerColor, "k").replace(/"/g, "'")}"></span>
          <span class="past-main"><span class="past-result">${esc(result(g))}</span>
          <span class="past-meta">${date} · ${levelName(g.level)} bot · ${g.summary.moves} moves${accuracyOf(g) === null ? "" : ` · ${Math.round(accuracyOf(g)!)}% accuracy`}</span></span>
          <span class="move-tactics">${icons}</span>
          <button class="icon-btn copy-code" title="Copy this game's code" aria-label="Copy game code"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 3h10a2 2 0 0 1 2 2v12h-2V5H8zM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h10V9z"/></svg></button></li>`;
      })
      .join("");

    $("games-body").innerHTML = games
      ? `<ul class="past-games">${games}</ul>`
      : `<p class="stat-empty">Finished games against the computer show up here.</p>`;
    $("games-body")
      .querySelectorAll<HTMLElement>(".past-game")
      .forEach((row) => {
        const open = () => {
          const g = this.stats.archive.find((x) => x.id === row.dataset.id);
          if (g) void this.openReview(g);
        };
        row.addEventListener("click", open);
        row.addEventListener("keydown", (e) => e.key === "Enter" && open());
        row.querySelector(".copy-code")?.addEventListener("click", async (e) => {
          e.stopPropagation(); // copy, don't open
          const g = this.stats.archive.find((x) => x.id === row.dataset.id);
          if (!g) return;
          await copyText(encodeGames([g]));
          this.flashNote("games-note", "Game code copied");
        });
      });
  }

  /** Opens a finished game from the history on the board, to look through. */
  private async openReview(g: GameRecord) {
    $<HTMLDialogElement>("games").close();
    if (this.settings.mode !== "play") await this.showMode("play");
    const save: GameSave = {
      fen: g.fen,
      moves: g.moves,
      playerColor: g.playerColor,
      level: g.level,
      id: g.id,
      sacs: g.sacs,
      evals: g.evals,
      bests: g.bests,
      graded: g.graded,
      stars: g.stars,
      date: g.date,
      takebacks: g.summary.takebacks,
    };
    this.startGame(save, false, g.result as GameResult);
  }

  private async closeReview() {
    this.reviewing = false;
    this.game?.dispose();
    this.game = null;
    if (!(await this.resumeGame())) this.showSetup();
  }

  // ---- controls ----

  private bindControls() {
    $("btn-hint").addEventListener("click", () => this.session?.hint());
    $("btn-retry").addEventListener("click", () => this.retry());
    $("btn-next").addEventListener("click", () => this.nextPuzzle());
    $("tab-puzzles").addEventListener("click", () => void this.showMode("puzzles"));
    $("tab-play").addEventListener("click", () => void this.showMode("play"));
    $("btn-takeback").addEventListener("click", () => this.game?.takeback());
    $("btn-resign").addEventListener("click", () => this.game?.resign());
    $("btn-new-game").addEventListener("click", () => this.showSetup());
    $("btn-close-review").addEventListener("click", () => void this.closeReview());
    $("btn-over-close").addEventListener("click", () => $<HTMLDialogElement>("game-over").close());
    $("btn-over-new").addEventListener("click", () => {
      $<HTMLDialogElement>("game-over").close();
      this.showSetup();
    });
    $("btn-stats").addEventListener("click", () => this.openStats());
    $("btn-games").addEventListener("click", () => this.openGames());
    $("btn-close-games").addEventListener("click", () => $<HTMLDialogElement>("games").close());
    $("btn-import-games").addEventListener("click", () => this.importGames());
    $("btn-copy-all-games").addEventListener("click", async () => {
      if (!this.stats.archive.length) return this.flashNote("games-note", "No games to copy yet");
      await copyText(encodeGames(this.stats.archive));
      this.flashNote("games-note", `Copied ${this.stats.archive.length} game${this.stats.archive.length === 1 ? "" : "s"} as one code`);
    });
    $("btn-close-stats").addEventListener("click", () => $<HTMLDialogElement>("stats").close());
    for (const btn of $("stats-view").children) {
      btn.addEventListener("click", () => {
        this.statsView = (btn as HTMLElement).dataset.id === "bot" ? "bot" : "puzzles";
        this.renderStats();
        $<HTMLDialogElement>("stats").scrollTop = 0;
      });
    }
    $("btn-copy-state").addEventListener("click", () => void this.copyState());
    $("btn-settings").addEventListener("click", () => {
      $<HTMLDialogElement>("settings").showModal();
      // Long list: bring the chosen set into view.
      $("opt-piece-set").querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
    });
    $("btn-close-settings").addEventListener("click", () => $<HTMLDialogElement>("settings").close());
    // Clicking outside a menu (on the backdrop) closes it.
    for (const dialog of document.querySelectorAll("dialog")) {
      dialog.addEventListener("click", (e) => {
        if (e.target !== dialog) return; // a click on something inside (or a key press on a button)
        const r = dialog.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) dialog.close();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ($<HTMLDialogElement>("settings").open || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.settings.mode === "play") {
        const g = this.game;
        if (!g) return;
        const len = g.state.san.length;
        const at = g.state.viewing ?? len;
        const target = { ArrowLeft: at - 1, ArrowRight: at + 1, ArrowUp: 0, Home: 0, ArrowDown: len, End: len }[e.key];
        if (target === undefined) return;
        e.preventDefault();
        g.browse(target);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "h") this.session?.hint();
      else if (key === "n" || (key === "enter" && this.session?.state.done)) this.nextPuzzle();
      else if (key === "r" && this.session?.state.done) this.retry();
    });
  }

  private buildSettingsDialog() {
    const pieceSets = $("opt-piece-set");
    const setName = $("piece-set-name");
    setName.textContent = pieceSetById(this.settings.pieceSet).name;
    for (const set of PIECE_SETS) {
      const btn = document.createElement("button");
      btn.className = "piece-swatch";
      btn.title = set.name;
      btn.setAttribute("aria-label", `${set.name} pieces`);
      for (const [cls, color] of [["ps-back", "b"], ["ps-front", "w"]] as const) {
        const knight = document.createElement("span");
        knight.className = cls;
        knight.style.backgroundImage = set.url(color, "n");
        btn.append(knight);
      }
      btn.setAttribute("aria-pressed", String(set.id === this.settings.pieceSet));
      btn.addEventListener("click", () => {
        pieceSets.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        btn.setAttribute("aria-pressed", "true");
        setName.textContent = set.name;
        void this.update("pieceSet", set.id);
      });
      pieceSets.append(btn);
    }

    const anim = $<HTMLSelectElement>("opt-animation");
    fillSelect(anim, ANIMATION_SPEEDS, this.settings.animation);
    anim.addEventListener("change", () => this.update("animation", anim.value));

    const checks: [string, "sound" | "showLegal" | "showCoords" | "clickToMove" | "showTactics" | "enemyTactics" | "tacticHighlight" | "tacticArrows" | "showQuality" | "evalBar" | "fairLive" | "autoNext" | "kingGlow" | "devMode"][] = [
      ["opt-sound", "sound"],
      ["opt-legal", "showLegal"],
      ["opt-coords", "showCoords"],
      ["opt-clickmove", "clickToMove"],
      ["opt-tactics", "showTactics"],
      ["opt-enemy-tactics", "enemyTactics"],
      ["opt-tactic-highlight", "tacticHighlight"],
      ["opt-tactic-arrows", "tacticArrows"],
      ["opt-quality", "showQuality"],
      ["opt-evalbar", "evalBar"],
      ["opt-fair-live", "fairLive"],
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

function startPosition() {
  const pos = new Map<string, string>();
  const back = "rnbqkbnr";
  for (let f = 0; f < 8; f++) {
    const file = "abcdefgh"[f];
    pos.set(`${file}1`, "w" + back[f]);
    pos.set(`${file}2`, "wp");
    pos.set(`${file}7`, "bp");
    pos.set(`${file}8`, "b" + back[f]);
  }
  return pos;
}

function segButton(id: string, label: string, title: string) {
  const btn = document.createElement("button");
  btn.dataset.id = id;
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute("role", "radio");
  return btn;
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

/** Puts `text` on the clipboard (through a hidden text box on older webviews). */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}
