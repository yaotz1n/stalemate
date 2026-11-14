// One game against the bot: takes the player's moves, asks the engine for
// replies, detects the result, and supports takebacks and resigning. Progress
// is saved after every move (see GameSave) so a game survives closing the app.

import { Chess, type Move } from "chess.js";
import { api, type PositionEval } from "./api";
import type { Board, Position, Square } from "./board";
import type { PieceColor, PieceType } from "./pieces";
import type { Sounds } from "./sounds";
import { classify, gameAccuracy, pliesOf, winChance, type Quality } from "./quality";
import { summarize, type GameRecord } from "./stats";
import { moveLabel, sacrificeCandidate, tacticDetails, withSacrifice, type TacticDetail, type TacticLogEntry } from "./tactics";

/** The current grader: Stockfish, with its runner-up move (for the ★). Grades made otherwise are redone. */
export const GRADER = "stockfish-2";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const BOT_LEVELS = [
  { level: 1, name: "Beginner" },
  { level: 2, name: "Casual" },
  { level: 3, name: "Club" },
  { level: 4, name: "Strong" },
  { level: 5, name: "Expert" },
];

export function levelName(level: number) {
  return BOT_LEVELS.find((l) => l.level === level)?.name ?? `Level ${level}`;
}

/** A game in progress, as saved between app runs. */
export interface GameSave {
  fen: string;
  /** UCI moves played from `fen`. */
  moves: string[];
  playerColor: PieceColor;
  level: number;
  /** Identifies the game in the history of finished games (older saves have none). */
  id?: string;
  /** Takebacks so far, for the stats. */
  takebacks?: number;
  /** Plies of the player's moves the engine confirmed as sound sacrifices. */
  sacs?: number[];
  /** A reviewed game's end date (it stays the same as late engine results update the history). */
  date?: string;
  /** The engine's verdict on each move so far: ply -> [best score, the move's score], for the side that moved. */
  evals?: Record<number, [number, number]>;
  /** What Stockfish would have played instead, for moves that weren't the best: ply -> UCI. */
  bests?: Record<number, string>;
  /** Which grader the grades come from (GRADER; older ones are redone). */
  graded?: string;
  /** Plies of best moves that were also the only good move (they get the ★). */
  stars?: number[];
}

export interface GameResult {
  /** null for a draw. */
  winner: PieceColor | null;
  reason: "checkmate" | "resignation" | "stalemate" | "repetition" | "insufficient material" | "50-move rule";
}

export interface GameState {
  status: "your-turn" | "thinking" | "over";
  playerColor: PieceColor;
  level: number;
  /** Moves in SAN, in order. */
  san: string[];
  result: GameResult | null;
  canTakeback: boolean;
  /** Moves that set up tactics, oldest first: the player's, and the bot's with that setting on. */
  tacticLog: TacticLogEntry[];
  /** Number of moves shown while looking back through the game; null when showing the current position. */
  viewing: number | null;
  /** A finished game opened from the history: look only. */
  review: boolean;
  /** How good each move in `san` was, once the engine has judged it (null: not yet, or during a fair live review). */
  quality: (Quality | null)[];
  /** White's score (centipawns) in the position on screen; null if not known yet. */
  evalCp: number | null;
  /** The player's accuracy (0-100) once all their moves are graded; null before. */
  accuracy: number | null;
  /** The bot's, likewise (shown in a full review). */
  botAccuracy: number | null;
  /** Grades, the eval bar and the bot's info show: false during a fair live review. */
  fullReview: boolean;
}

export interface GameHooks {
  onChange(state: GameState): void;
  /** Called after every change; null once the game is over (nothing to resume). */
  onSave(save: GameSave | null): void;
  timing(): { animMs: number };
  /** Whether to badge the player's forks, pins and skewers. */
  tactics(): boolean;
  /** Whether to badge the opponent's too (yellow). */
  enemyTactics(): boolean;
  /** Whether to show move quality (best move, blunder...). */
  quality(): boolean;
  /** "Fair live review": while the game is on, no move grades, and only the player's own tactics in their colors. */
  fairLive(): boolean;
  /** The game has ended (again, after a takeback: same id): keep it in the history. */
  onGameOver(record: GameRecord): void;
  /** A finished game was taken back, so it's no longer finished. */
  onGameReopened(id: string): void;
}

export class GameSession {
  private chess: Chess;
  private uci: string[] = [];
  private status: GameState["status"] = "your-turn";
  private result: GameResult | null = null;
  private timers: number[] = [];
  /** Bumped to cancel a reply that's still being computed. */
  private thinkToken = 0;
  private disposed = false;
  /** Tactics per move, keyed by the moves up to it, so they're worked out once. */
  private tacticCache = new Map<string, TacticDetail[]>();
  /** Plies shown while browsing past moves; null = the live position. */
  private view: number | null = null;
  readonly playerColor: PieceColor;
  readonly level: number;
  private readonly startFen: string;
  readonly id: string;
  private takebacks: number;
  /** When the game ended (kept for the history while late engine results come in). */
  private endedAt: string | undefined;
  /** Plies of the player's moves confirmed as sound sacrifices (see checkSacrifice). */
  private sacs: Set<number>;
  /** The engine's verdict per move: ply -> [best score, the move's score] for the side that moved (see judge). */
  private evals: Map<number, [number, number]>;
  /** Stockfish's analyses, by the moves leading to the position. */
  private positionCache = new Map<string, Promise<PositionEval | null>>();
  /** For the player's moves that weren't the best: what Stockfish would have played, by ply. */
  private bests: Map<number, string>;
  /** Which grader `evals` came from (see GRADER). */
  private graded: string | undefined;
  /** Plies of best moves that were the only good move: those get the ★. */
  private stars: Set<number>;
  /** Engine checks in progress, by ply. */
  private judgingPly = new Map<number, Promise<void>>();
  /** The player's latest engine check; the bot's reply waits for it so its badges show first. */
  private judging: Promise<void> | null = null;

  /** `review`: a finished game from the history, shown at its end and only browsable. */
  constructor(
    save: GameSave,
    private board: Board,
    private sounds: Sounds,
    private hooks: GameHooks,
    private readonly review: GameResult | null = null,
  ) {
    this.id = save.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.takebacks = save.takebacks ?? 0;
    this.endedAt = save.date;
    this.sacs = new Set(save.sacs ?? []);
    this.evals = new Map(Object.entries(save.evals ?? {}).map(([k, v]) => [Number(k), v]));
    this.bests = new Map(Object.entries(save.bests ?? {}).map(([k, v]) => [Number(k), v]));
    this.graded = save.graded;
    this.stars = new Set(save.stars ?? []);
    this.startFen = save.fen;
    this.playerColor = save.playerColor;
    this.level = save.level;
    this.chess = new Chess(save.fen);
    for (const uci of save.moves) {
      this.chess.move(uciToMove(uci));
      this.uci.push(uci);
    }
  }

  /** Shows the game; a new game builds the board in, a resumed one appears as it was. */
  start(fresh: boolean) {
    this.board.setMovable(null);
    this.board.setResult(null);
    this.board.setArrow(null);
    this.board.setTactics(null);
    this.board.setOrientation(this.playerColor);
    this.board.setPosition(position(this.chess));
    this.highlightLast();
    this.showBadges(this.uci.length, 0); // a resumed game ending on your move shows its badges
    if (this.review) {
      this.result = this.review;
      this.status = "over";
      this.showResultBadges(0);
      this.hooks.onChange(this.state);
      void this.judgeAll(); // games saved before move grading (or cut short) get graded now
      return;
    }
    if (this.uci.length) void this.judge(this.uci.length).then(() => this.judgeAll()); // eval bar now, then any old grades
    const buildMs = fresh ? this.buildBoard() : 0;
    this.later(buildMs, () => this.nextTurn());
  }

  dispose() {
    this.disposed = true;
    this.thinkToken++;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  get state(): GameState {
    return {
      status: this.status,
      playerColor: this.playerColor,
      level: this.level,
      san: this.chess.history(),
      result: this.result,
      canTakeback: !this.review && this.playerMoves() > 0,
      tacticLog: this.tacticLog(),
      viewing: this.view,
      review: !!this.review,
      quality: this.chess.history({ verbose: true }).map((_, i) => (this.fullReview() ? this.shownQuality(i + 1) : null)),
      evalCp: this.shownEval(),
      accuracy: gameAccuracy(this.evals, pliesOf(this.playerColor, this.startFen.split(" ")[1] === "b" ? "b" : "w", this.uci.length)),
      fullReview: this.fullReview(),
      botAccuracy: this.fullReview()
        ? gameAccuracy(this.evals, pliesOf(opposite(this.playerColor), this.startFen.split(" ")[1] === "b" ? "b" : "w", this.uci.length))
        : null,
    };
  }

  handleMove(from: Square, to: Square, promotion?: PieceType) {
    if (this.status !== "your-turn" || this.view !== null) return;
    this.board.setMovable(null);
    let move: Move;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      this.enableInput();
      return;
    }
    this.uci.push(move.from + move.to + (move.promotion ?? ""));
    const landMs = this.board.travelMs(move.to);
    this.show(move);
    // A move with a tactic gets the puzzles' "correct" chime as its badges pop in.
    const badged = this.showBadges(this.uci.length, landMs);
    if (badged) this.sounds.play("correct", { step: 0, delay: landMs / 1000 });
    // The engine grades the move (quality badge, eval bar) and confirms a sacrifice; badges come a moment later.
    this.judging = this.judge(this.uci.length, !badged && this.hooks.tactics() && sacrificeCandidate(this.chess, move));
    this.nextTurn();
  }

  /** Undoes the player's last move (and the bot's reply to it). Also works after the game ends. */
  takeback() {
    if (this.review || this.playerMoves() === 0) return;
    if (this.result) this.hooks.onGameReopened(this.id);
    this.takebacks++;
    this.thinkToken++; // drop a reply that's still on its way
    this.timers.forEach(clearTimeout);
    this.timers = [];
    do {
      this.chess.undo();
      this.uci.pop();
    } while (this.chess.turn() !== this.playerColor);
    for (const ply of this.sacs) if (ply > this.uci.length) this.sacs.delete(ply);
    for (const ply of this.evals.keys()) if (ply > this.uci.length) this.evals.delete(ply);
    for (const ply of this.bests.keys()) if (ply > this.uci.length) this.bests.delete(ply);
    for (const ply of this.stars) if (ply > this.uci.length) this.stars.delete(ply);
    this.result = null;
    this.view = null;
    this.board.setTactics(null);
    this.board.setResult(null);
    this.board.setPosition(position(this.chess), { animate: true }); // also stands a fallen king back up
    this.highlightLast();
    this.sounds.play("move");
    this.nextTurn();
  }

  resign() {
    if (this.status === "over") return;
    this.thinkToken++;
    if (this.view !== null) this.browse(Infinity);
    this.end({ winner: opposite(this.playerColor), reason: "resignation" });
    this.sounds.play("wrong");
  }

  /**
   * Shows the position after `ply` moves (clamped; past the end means the live
   * position). The board steps there one move at a time like the game itself.
   */
  browse(ply: number) {
    const history = this.chess.history({ verbose: true });
    const target = Math.max(0, Math.min(ply, history.length));
    const current = this.view ?? history.length;
    if (target === current) return;
    this.view = target === history.length ? null : target;
    const move = target > 0 ? history[target - 1] : undefined;
    const shown = new Chess(move ? move.after : this.startFen);
    const step = Math.abs(target - current) === 1;
    if (target > 0) void this.judge(target); // older moves of a resumed game may not be judged yet
    // Pieces slide to where they stand in the shown position, for jumps too.
    this.board.setPosition(position(shown), { animate: true, lastMove: step && target > current && move ? [move.from, move.to] : undefined });
    let check: Square | undefined;
    if (shown.inCheck()) check = shown.findPiece({ type: "k", color: shown.turn() })[0];
    this.board.setHighlights({ lastMove: move ? [move.from, move.to] : undefined, check });
    // The sound of the move now shown, as it sounded when played (landing with the slide, if any).
    if (move) this.playMoveSound(move, shown.inCheck(), this.hooks.timing().animMs / 1000);
    else this.sounds.play("move");
    // Badges pop in with the same chime as when the move was played.
    if (this.showBadges(target, this.hooks.timing().animMs)) this.sounds.play("correct", { step: 0, delay: this.hooks.timing().animMs / 1000 });
    this.showResultBadges(0);
    if (this.view === null) {
      if (this.chess.isCheckmate()) this.board.setFallen(this.chess.findPiece({ type: "k", color: this.chess.turn() })[0]);
      if (this.status === "your-turn") this.enableInput();
    } else {
      this.board.setMovable(null);
    }
    this.hooks.onChange(this.state);
  }

  private tacticLog(): TacticLogEntry[] {
    if (!this.hooks.tactics()) return [];
    const full = this.fullReview();
    return this.chess.history({ verbose: true }).flatMap((m, i) => {
      const bots = m.color !== this.playerColor;
      if (bots && !full && !this.hooks.enemyTactics()) return [];
      const details = this.detailsOf(i + 1, m);
      // In a full review the bot's tactics look like the player's; otherwise they're the yellow ones.
      return details.length ? [{ ply: i + 1, label: moveLabel(m), details, enemy: bots && !full }] : [];
    });
  }

  /**
   * Whether the bot's moves get everything the player's do (grades, badges in
   * their own colors, better-move arrows): always, except during a live game
   * with "Fair live review" on. Finished and reviewed games always get it.
   */
  private fullReview(): boolean {
    return !this.hooks.fairLive() || this.result !== null || !!this.review;
  }

  /** The tactics of the move at `ply` (worked out once), with a confirmed sacrifice added. */
  private detailsOf(ply: number, m: Move): TacticDetail[] {
    // Keyed by the game so far: a capture's badges depend on the trade before it.
    const key = this.uci.slice(0, ply).join(" ");
    let details = this.tacticCache.get(key);
    if (!details) {
      const before = this.chess.history({ verbose: true }).slice(0, ply - 1);
      this.tacticCache.set(key, (details = tacticDetails(new Chess(m.after), m, before)));
    }
    return this.sacs.has(ply) && (m.color === this.playerColor || this.fullReview()) ? withSacrifice(details, m) : details;
  }

  /**
   * Asks the engine how the move at `ply` compares with the best move there.
   * That grades it (move quality), gives the eval bar its number, and decides
   * whether a move that gave up material is a sound sacrifice (as good as the
   * best move, within half a pawn, and not losing). Badges update when it's in;
   * `chimeIfSac`: play the tactic chime if it turns out to be a sacrifice.
   */
  private judge(ply: number, chimeIfSac = false, ms = 300): Promise<void> {
    if (this.evals.has(ply)) return Promise.resolve();
    const pending = this.judgingPly.get(ply);
    if (pending) return pending;
    const mv = this.uci[ply - 1];
    const job = (async () => {
      // Stockfish: the positions before and after the move (each analysed once,
      // shared with the neighbouring moves). Without it, our own engine judges the move.
      let r: [number, number] | null = null;
      let bestMove: string | null = null;
      const [before, after] = await Promise.all([this.position(ply - 1, ms), this.position(ply, ms)]);
      if (before && after) {
        const best = before.score;
        // Stockfish's own choice is "best" by definition; any other move scores no better than it.
        const score = before.best === mv ? best : Math.min(best, -after.score);
        r = [best, score];
        bestMove = before.best;
        if (!this.evals.size) this.graded = GRADER;
        // The ★: the best move where the runner-up was clearly worse (10+ points of win chance).
        if (before.best === mv && before.second != null && winChance(best) - winChance(before.second) >= 10) this.stars.add(ply);
      } else {
        try {
          r = await api.judgeMove(this.startFen, this.uci.slice(0, ply - 1), mv, ms * 2);
        } catch (e) {
          console.error("judging a move failed", e);
        }
      }
      this.judgingPly.delete(ply);
      if (this.disposed || this.uci[ply - 1] !== mv || !r) return;
      this.evals.set(ply, r);
      if (bestMove && bestMove !== mv) this.bests.set(ply, bestMove);
      const m = this.chess.history({ verbose: true })[ply - 1];
      const [best, score] = r;
      let sac = false;
      if (this.hooks.tactics() && sacrificeCandidate(new Chess(m.after), m)) {
        sac = score >= best - 50 && score >= -50;
        if (sac) this.sacs.add(ply);
      }
      if ((this.view ?? this.uci.length) === ply) {
        this.showBadges(ply, 0);
        if (sac && chimeIfSac && m.color === this.playerColor) this.sounds.play("correct", { step: 0 });
      }
      if (this.result) this.hooks.onGameOver(this.record());
      this.emit();
    })();
    this.judgingPly.set(ply, job);
    return job;
  }

  /** Looks up the better move for a mistake graded without one (e.g. by an older grader), then shows its arrow. */
  private async fillBest(ply: number) {
    const mv = this.uci[ply - 1];
    const a = await this.position(ply - 1, 300);
    if (this.disposed || this.uci[ply - 1] !== mv || !a?.best || a.best === mv || this.bests.has(ply)) return;
    this.bests.set(ply, a.best);
    if ((this.view ?? this.uci.length) === ply) this.showBadges(ply, 0);
    if (this.result) this.hooks.onGameOver(this.record());
    this.emit();
  }

  /**
   * Stockfish's analysis of the position after `ply` moves (worked out once);
   * null if Stockfish isn't available. Game-over positions need no search.
   */
  private position(ply: number, ms: number): Promise<PositionEval | null> {
    const key = this.uci.slice(0, ply).join(" ");
    let job = this.positionCache.get(key);
    if (!job) {
      const m = ply > 0 ? this.chess.history({ verbose: true })[ply - 1] : undefined;
      const board = new Chess(m ? m.after : this.startFen);
      if (board.isCheckmate()) job = Promise.resolve({ score: -30_000, best: null });
      else if (board.isStalemate() || board.isInsufficientMaterial()) job = Promise.resolve({ score: 0, best: null });
      else job = api.analysePosition(this.startFen, this.uci.slice(0, ply), ms).catch(() => null);
      this.positionCache.set(key, job);
    }
    return job;
  }

  /**
   * Judges every move not judged yet, in the background with shorter searches
   * than a live move gets. Stockfish takes them one at a time (using several
   * cores each); the move on screen jumps the queue through browse.
   */
  private async judgeAll() {
    // Grades from our own engine (or an older Stockfish setup) are redone once Stockfish is there.
    if (this.graded !== GRADER && this.evals.size && (await this.position(0, 50))) {
      this.evals.clear();
      this.bests.clear();
      this.stars.clear();
      this.emit();
    }
    const workers = 2; // keeps the next request queued while one runs
    let next = 1;
    const work = async () => {
      while (next <= this.uci.length && !this.disposed) await this.judge(next++, false, 150);
    };
    await Promise.all(Array.from({ length: workers }, work));
  }

  /** The quality of the move at `ply`, once the engine has judged it. */
  private qualityOf(ply: number): Quality | null {
    const r = this.evals.get(ply);
    return r ? classify(r[0], r[1]) : null;
  }

  /**
   * The grade to show for the move at `ply`: a best move only shows (★) when it
   * was the only good move; other best moves read as plain good ones. (Stats and
   * accuracy still count them all as best.)
   */
  private shownQuality(ply: number): Quality | null {
    const q = this.qualityOf(ply);
    return q === "best" && !this.stars.has(ply) ? "good" : q;
  }

  /** White's score in the position on screen, or the latest known before it while the engine works. */
  private shownEval(): number | null {
    for (let ply = this.view ?? this.uci.length; ply >= 0; ply--) {
      const e = this.evalAfter(ply);
      if (e !== null) return e;
    }
    return null;
  }

  /** White's score (centipawns) after `ply` moves, if known; 0 at the start. */
  private evalAfter(ply: number): number | null {
    if (ply === 0) return 0;
    const r = this.evals.get(ply);
    if (!r) return null;
    const mover = this.chess.history({ verbose: true })[ply - 1]?.color;
    return mover === "w" ? r[1] : -r[1];
  }

  /** Everything about the game, for the dev "Copy game state" button. */
  debugState() {
    const history = this.chess.history({ verbose: true });
    const shownPly = this.view ?? history.length;
    const last = shownPly > 0 ? history[shownPly - 1] : undefined;
    const upTo = new Chess(this.startFen);
    for (const m of history.slice(0, shownPly)) upTo.move(m);
    return {
      // The position on screen (a past move while browsing history).
      shown: {
        ply: shownPly,
        live: this.view === null,
        move: last && {
          label: `${Math.ceil(shownPly / 2)}${last.color === "w" ? "." : "…"} ${last.san}`,
          uci: last.from + last.to + (last.promotion ?? ""),
          by: last.color === this.playerColor ? "player" : "bot",
        },
        fen: last ? last.after : this.startFen,
        movesSoFar: upTo.pgn().replace(/^\[.*\]\n/gm, "").trim(),
        // Recomputed for this move, whatever the setting says (only the player's moves get badges).
        tactics: last ? tacticDetails(new Chess(last.after), last, history.slice(0, shownPly - 1)) : [],
      },
      game: {
        startFen: this.startFen,
        fen: this.chess.fen(),
        moves: this.chess.pgn().replace(/^\[.*\]\n/gm, "").trim(),
        uci: this.uci.join(" "),
        playerColor: this.playerColor,
        level: this.level,
        status: this.status,
        result: this.result,
        tacticsByMove: history.flatMap((m, i) =>
          m.color === this.playerColor ? [{ ply: i + 1, san: m.san, tactics: tacticDetails(new Chess(m.after), m, history.slice(0, i)) }] : [],
        ),
      },
    };
  }

  /** Decides what happens next: game over, the player's move, or the bot's. */
  private nextTurn() {
    const result = this.gameResult();
    if (result) {
      this.end(result);
      return;
    }
    if (this.chess.turn() === this.playerColor) {
      this.status = "your-turn";
      if (this.view === null) this.enableInput();
      this.emit();
    } else {
      this.think();
    }
  }

  private async think() {
    this.status = "thinking";
    this.board.setMovable(null);
    this.emit();
    const token = ++this.thinkToken;
    const started = performance.now();
    let reply: string | null;
    try {
      reply = await api.botMove(this.startFen, [...this.uci], this.level);
    } catch (e) {
      console.error("bot move failed", e);
      reply = null;
    }
    // Let a sacrifice check finish first, so its badge shows before the reply clears it.
    await this.judging;
    this.judging = null;
    if (token !== this.thinkToken || this.disposed) return;
    if (!reply) {
      // Shouldn't happen (game over is caught before asking); let the player continue.
      this.status = "your-turn";
      if (this.view === null) this.enableInput();
      this.emit();
      return;
    }
    // Let the player's move land and give the bot a moment, so replies don't feel instant.
    const minMs = this.hooks.timing().animMs + 250 + Math.random() * 350;
    const wait = Math.max(0, minMs - (performance.now() - started));
    this.later(wait, () => {
      if (token !== this.thinkToken) return;
      if (this.view !== null) this.browse(Infinity);
      const move = this.chess.move(uciToMove(reply));
      this.uci.push(reply);
      this.show(move);
      this.showBadges(this.uci.length, this.board.travelMs(move.to));
      void this.judge(this.uci.length); // for the eval bar
      this.nextTurn();
    });
  }

  private end(result: GameResult) {
    this.result = result;
    this.status = "over";
    this.endedAt ??= new Date().toISOString();
    this.hooks.onGameOver(this.record());
    void this.judgeAll(); // grade any moves that weren't (e.g. from before a resume) for the saved game
    this.board.setMovable(null);
    this.emit();
    if (this.hooks.fairLive()) this.showBadges(this.view ?? this.uci.length, 0); // the full review opens up now
    const landing = this.hooks.timing().animMs / 1000;
    // After a checkmate the king tips over first (see show()), then the badges pop in.
    this.showResultBadges(result.reason === "checkmate" ? this.hooks.timing().animMs + 500 : 0);
    if (result.reason === "checkmate") {
      if (result.winner === this.playerColor) this.sounds.play("solved", { step: 4, delay: landing });
    } else if (result.winner === null) {
      this.sounds.play("hint", { delay: landing });
    }
  }

  /** Winner/loser badges on the kings (none for a draw, or while looking back through history). */
  private showResultBadges(delayMs: number) {
    const r = this.result;
    if (!r || r.winner === null || this.view !== null || (r.reason !== "checkmate" && r.reason !== "resignation")) {
      this.board.setResult(null);
      return;
    }
    const king = (c: PieceColor) => this.chess.findPiece({ type: "k", color: c })[0];
    this.board.setResult({ win: king(r.winner), lose: king(opposite(r.winner)), how: r.reason === "checkmate" ? "mate" : "resign" }, delayMs);
  }

  /** The finished game, for the history. */
  private record(): GameRecord {
    return {
      id: this.id,
      date: this.endedAt ?? new Date().toISOString(),
      fen: this.startFen,
      moves: [...this.uci],
      playerColor: this.playerColor,
      level: this.level,
      result: this.result!,
      sacs: [...this.sacs],
      evals: Object.fromEntries(this.evals),
      bests: Object.fromEntries(this.bests),
      graded: this.graded,
      stars: [...this.stars],
      summary: summarize(this.chess.history({ verbose: true }), this.playerColor, this.takebacks, [...this.sacs], this.evals),
    };
  }

  private gameResult(): GameResult | null {
    const c = this.chess;
    if (c.isCheckmate()) return { winner: opposite(c.turn()), reason: "checkmate" };
    if (c.isStalemate()) return { winner: null, reason: "stalemate" };
    if (c.isInsufficientMaterial()) return { winner: null, reason: "insufficient material" };
    if (c.isThreefoldRepetition()) return { winner: null, reason: "repetition" };
    if (c.isDrawByFiftyMoves()) return { winner: null, reason: "50-move rule" };
    return null;
  }

  private playerMoves() {
    const history = this.chess.history({ verbose: true });
    return history.filter((m) => m.color === this.playerColor).length;
  }

  /**
   * Badges the move that led to the position after `ply` moves, if it was the
   * player's (the bot's moves never get badges, and the reply clears them).
   */
  /**
   * Badges the move that led to the position after `ply` moves: the player's,
   * or with the setting on the bot's (in yellow). Returns whether the player's
   * move got badges (those get a chime).
   */
  private showBadges(ply: number, delayMs: number): boolean {
    const move = ply > 0 ? this.chess.history({ verbose: true })[ply - 1] : undefined;
    const mine = move?.color === this.playerColor;
    const full = this.fullReview();
    // The bot's moves get the same treatment as the player's in a full review; otherwise only its tactics, in yellow.
    const wanted = move && (mine || full ? this.hooks.tactics() : this.hooks.enemyTactics());
    const details = wanted ? this.detailsOf(ply, move) : [];
    // Fair live review: no grades at all until the game is over (tactics only).
    const q = full && this.hooks.quality() ? this.shownQuality(ply) : null;
    const quality = q && q !== "good" ? q : null; // plain good moves get no badge
    // After a mistake or blunder, a green arrow shows what Stockfish would have played.
    if ((q === "mistake" || q === "blunder") && !this.bests.has(ply)) void this.fillBest(ply);
    const better = (q === "mistake" || q === "blunder") && this.bests.get(ply);
    const betterMove: [Square, Square] | null = better ? [better.slice(0, 2), better.slice(2, 4)] : null;
    this.board.setTactics(details.length || quality ? move!.to : null, details, delayMs, !mine && !full, quality, betterMove);
    return mine && details.length > 0;
  }

  /** Animates a move with its sound; a checkmated king tips over (the board stays put, unlike puzzles). */
  private show(move: Move) {
    if (move.color !== this.playerColor) this.board.setTactics(null); // badges last until the reply
    const opts = { piece: move.piece, delay: this.board.travelMs(move.to) / 1000 };
    this.board.setPosition(position(this.chess), { animate: true, lastMove: [move.from, move.to] });
    this.highlightLast();
    if (this.chess.isCheckmate()) {
      const king = this.chess.findPiece({ type: "k", color: this.chess.turn() })[0];
      this.later(this.hooks.timing().animMs + 60, () => {
        this.board.setFallen(king);
        this.sounds.play("thud", { delay: 0.45 });
      });
    }
    this.playMoveSound(move, this.chess.inCheck(), opts.delay);
  }

  private playMoveSound(move: Move, check: boolean, delay: number) {
    const opts = { piece: move.piece, delay };
    if (check) this.sounds.play("check", opts);
    else if (move.isCapture() || move.isEnPassant()) this.sounds.play("capture", opts);
    else if (move.isKingsideCastle() || move.isQueensideCastle()) this.sounds.play("castle", opts);
    else if (move.isPromotion()) this.sounds.play("promote", opts);
    else this.sounds.play("move", opts);
  }

  private highlightLast() {
    const last = this.chess.history({ verbose: true }).at(-1);
    let check: Square | undefined;
    if (this.chess.inCheck()) check = this.chess.findPiece({ type: "k", color: this.chess.turn() })[0];
    this.board.setHighlights({ lastMove: last ? [last.from, last.to] : undefined, check });
  }

  /** Fancy animation: builds the board outward from both kings. Returns its duration (0 otherwise). */
  private buildBoard() {
    const kings = [...this.chess.findPiece({ type: "k", color: "w" }), ...this.chess.findPiece({ type: "k", color: "b" })];
    const { ms, rings, stepMs } = this.board.build(kings);
    if (ms) for (let ring = 0; ring <= rings; ring++) this.sounds.play("build", { step: ring, delay: (ring * stepMs) / 1000 });
    return ms;
  }

  private enableInput() {
    const dests = new Map<Square, Square[]>();
    for (const m of this.chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      const list = dests.get(m.from)!;
      if (!list.includes(m.to)) list.push(m.to);
    }
    this.board.setMovable(this.playerColor, dests);
  }

  private emit() {
    this.hooks.onSave(
      this.status === "over"
        ? null
        : { fen: this.startFen, moves: [...this.uci], playerColor: this.playerColor, level: this.level, id: this.id, takebacks: this.takebacks, sacs: [...this.sacs], evals: Object.fromEntries(this.evals), bests: Object.fromEntries(this.bests), graded: this.graded, stars: [...this.stars] },
    );
    this.hooks.onChange(this.state);
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }
}

function opposite(c: PieceColor): PieceColor {
  return c === "w" ? "b" : "w";
}

function uciToMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function position(chess: Chess): Position {
  const pos: Position = new Map();
  for (const row of chess.board()) {
    for (const p of row) if (p) pos.set(p.square, p.color + p.type);
  }
  return pos;
}
