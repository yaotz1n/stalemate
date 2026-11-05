// One puzzle attempt: plays the opponent's moves, checks the player's moves
// against the solution, handles hints and "show solution", and reports the
// result to the backend once (the first mistake/hint counts as a fail, like
// chess.com and Lichess).

import { Chess, type Move, type Square as ChessSquare } from "chess.js";
import { api, type AttemptResult, type Puzzle } from "./api";
import type { Board, Position, Square } from "./board";
import type { PieceColor, PieceType } from "./pieces";
import type { Sounds } from "./sounds";

export type Status =
  | "intro" // opponent's setup move is about to play
  | "your-turn"
  | "correct" // right move, opponent about to reply
  | "wrong" // wrong move, about to be taken back
  | "solved"
  | "solution"; // solution shown, puzzle over

export interface SessionState {
  puzzle: Puzzle;
  status: Status;
  playerColor: PieceColor;
  /** Hints shown for the current move (0-2); resets after each correct move. */
  hintLevel: number;
  mistakes: number;
  /** Solved without mistakes or hints. */
  clean: boolean;
  done: boolean;
  /** The position is checkmate (the arcade board crumbles). */
  mate: boolean;
}

/** Saved progress through a puzzle, so it can be resumed after the app restarts. */
export interface Snapshot {
  puzzleId: string;
  /** Solution moves already played (0 = not started). Always odd while it's the player's turn. */
  ply: number;
  hintLevel: number;
  /** A hint was used at some point in this puzzle. */
  usedHint: boolean;
  mistakes: number;
  /** A result has already been recorded, so finishing won't change the rating again. */
  reported: boolean;
}

export interface SessionHooks {
  onChange(state: SessionState): void;
  onResult(result: AttemptResult): void;
  timing(): { animMs: number };
  /** Whether to glow the player's king square when the puzzle begins. */
  kingGlow(): boolean;
  /** A solved puzzle's ending (last move, king fall, board crumble) has finished playing. */
  onFinished(): void;
}

export class PuzzleSession {
  private chess: Chess;
  private solution: string[];
  private ply = 0;
  private status: Status = "intro";
  private hintLevel = 0;
  private usedHint = false;
  private mistakes = 0;
  private viewedSolution = false;
  /** Correct moves so far; each one's chime is pitched a step higher (arcade). */
  private correctCount = 0;
  private reported: boolean;
  private timers: number[] = [];
  private pendingRevert: (() => void) | null = null;
  readonly playerColor: PieceColor;

  constructor(
    readonly puzzle: Puzzle,
    private board: Board,
    private sounds: Sounds,
    private hooks: SessionHooks,
    /** Retries of an already-reported puzzle aren't recorded again. */
    alreadyReported = false,
    /** Dev mode: move either side freely; nothing is checked, scored or saved. */
    readonly dev = false,
  ) {
    this.reported = alreadyReported;
    this.chess = new Chess(puzzle.fen);
    this.solution = puzzle.moves.split(" ");
    this.playerColor = this.chess.turn() === "w" ? "b" : "w";
  }

  /** Starts the puzzle, or picks up where `resume` left off (shown instantly, no intro). */
  start(resume?: Snapshot) {
    this.board.setMovable(null);
    this.board.setOrientation(this.playerColor);
    this.board.setArrow(null);
    this.board.setHighlights({});

    if (resume && resume.ply % 2 === 1 && resume.ply < this.solution.length) {
      while (this.ply < resume.ply) {
        const uci = this.solution[this.ply++];
        this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      }
      this.hintLevel = Math.min(resume.hintLevel, 2);
      this.usedHint = !!resume.usedHint || this.hintLevel > 0;
      this.mistakes = resume.mistakes;
      this.reported ||= resume.reported;
      this.board.setPosition(position(this.chess));
      this.buildBoard();
      this.showHints();
      this.setStatus("your-turn");
      this.enableInput();
      return;
    }

    this.board.setPosition(position(this.chess));
    const buildMs = this.buildBoard();
    this.emit();
    this.later(buildMs ? buildMs + 250 : 600, () => {
      this.playSolutionMove();
      this.setStatus("your-turn");
      this.enableInput();
      if (this.hooks.kingGlow()) {
        const king = this.chess.findPiece({ type: "k", color: this.playerColor })[0];
        this.later(this.hooks.timing().animMs, () => this.board.glow(king));
      }
    });
  }

  /** Arcade: builds the board outward from both kings. Returns its duration (0 in Classic). */
  private buildBoard() {
    const kings = [...this.chess.findPiece({ type: "k", color: "w" }), ...this.chess.findPiece({ type: "k", color: "b" })];
    const { ms, rings, stepMs } = this.board.build(kings);
    if (ms) for (let ring = 0; ring <= rings; ring++) this.sounds.play("build", { step: ring, delay: (ring * stepMs) / 1000 });
    return ms;
  }

  dispose() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  get state(): SessionState {
    return {
      puzzle: this.puzzle,
      status: this.status,
      playerColor: this.playerColor,
      hintLevel: this.hintLevel,
      mistakes: this.mistakes,
      clean: this.mistakes === 0 && !this.usedHint && !this.viewedSolution,
      done: this.status === "solved" || this.status === "solution",
      mate: this.chess.isCheckmate(),
    };
  }

  handleMove(from: Square, to: Square, promotion?: PieceType) {
    if (this.status !== "your-turn") return;
    if (this.dev) {
      this.devMove(from, to, promotion);
      return;
    }
    this.board.setMovable(null);
    this.board.setArrow(null);
    const uci = from + to + (promotion ?? "");
    let move: Move;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      this.enableInput();
      return;
    }
    const correct = uci === this.solution[this.ply] || this.chess.isCheckmate();
    const landing = this.board.travelMs(to) / 1000;
    this.show(move, true);

    if (!correct) {
      this.mistakes++;
      this.board.setHighlights({ ...this.baseHighlights(move), mark: { square: to, kind: "bad" } });
      this.sounds.play("wrong", { delay: landing });
      this.report(false);
      this.setStatus("wrong");
      this.pendingRevert = () => {
        this.chess.undo();
        const last = this.chess.history({ verbose: true }).at(-1);
        this.board.setPosition(position(this.chess), { animate: true });
        this.board.setHighlights(last ? this.baseHighlights(last) : {});
      };
      this.later(this.hooks.timing().animMs + 550, () => {
        this.runPendingRevert();
        this.setStatus("your-turn");
        this.enableInput();
      });
      return;
    }

    this.ply++;
    this.hintLevel = 0; // hints are per move
    this.board.setHighlights({ ...this.baseHighlights(move), mark: { square: to, kind: "good" } });
    if (this.ply >= this.solution.length || this.chess.isGameOver()) {
      this.finish("solved", landing);
      return;
    }
    this.sounds.play("correct", { step: this.correctCount++, delay: landing });
    this.setStatus("correct");
    this.later(this.hooks.timing().animMs + 300, () => {
      this.playSolutionMove();
      this.setStatus("your-turn");
      this.enableInput();
    });
  }

  hint() {
    if (this.status !== "your-turn" || this.hintLevel >= 2) return;
    this.hintLevel++;
    this.usedHint = true;
    this.showHints();
    this.sounds.play("hint");
    this.report(false);
    this.emit();
  }

  /** Progress to save; null once the puzzle is over (nothing left to resume). */
  snapshot(): Snapshot | null {
    if (this.state.done) return null;
    return {
      puzzleId: this.puzzle.id,
      ply: this.status === "intro" ? 0 : this.ply,
      hintLevel: this.hintLevel,
      usedHint: this.usedHint,
      mistakes: this.mistakes,
      reported: this.reported,
    };
  }

  /** Draws the last-move highlight plus whatever hints have been used for the current move. */
  private showHints() {
    const last = this.chess.history({ verbose: true }).at(-1);
    const base = last ? this.baseHighlights(last) : {};
    if (this.hintLevel === 0) {
      this.board.setHighlights(base);
      return;
    }
    const uci = this.solution[this.ply];
    this.board.setHighlights({ ...base, hint: uci.slice(0, 2) });
    if (this.hintLevel >= 2) this.board.setArrow(uci.slice(0, 2), uci.slice(2, 4));
  }

  showSolution() {
    if (this.state.done) return;
    this.viewedSolution = true;
    this.dispose();
    this.runPendingRevert();
    this.report(false);
    this.board.setMovable(null);
    this.board.setArrow(null);
    this.setStatus("solution");
    const step = () => {
      if (this.ply >= this.solution.length) return;
      this.playSolutionMove();
      if (this.ply < this.solution.length) this.later(this.hooks.timing().animMs + 550, step);
    };
    this.later(250, step);
  }

  private playSolutionMove() {
    const uci = this.solution[this.ply++];
    const move = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    this.show(move, true);
    this.board.setHighlights(this.baseHighlights(move));
  }

  private finish(status: "solved", delay = 0) {
    this.setStatus(status);
    this.sounds.play("solved", { step: this.correctCount++, delay });
    this.report(this.mistakes === 0 && !this.viewedSolution);
    // A checkmate ending signals once the king (and arcade board) has fallen; see show().
    if (!this.chess.isCheckmate()) this.later(delay * 1000, () => this.finished());
  }

  private finished() {
    if (this.status === "solved") this.hooks.onFinished();
  }

  private show(move: Move, animate: boolean) {
    // Arcade sounds land with the piece; Classic plays them right away (it ignores delay).
    const opts = { piece: move.piece, delay: animate ? this.board.travelMs(move.to) / 1000 : 0 };
    this.board.setPosition(position(this.chess), { animate, lastMove: [move.from, move.to] });
    if (this.chess.isCheckmate()) {
      const king = this.chess.findPiece({ type: "k", color: this.chess.turn() })[0];
      this.later(animate ? this.hooks.timing().animMs + 60 : 0, () => {
        this.board.setFallen(king);
        this.sounds.play("thud", { delay: 0.45 }); // the fall hits the board ~65% through
        // Arcade: once the king is down, the board falls apart around it.
        this.later(600, () => {
          const { ms, rings, stepMs } = this.board.crumble(king);
          for (let ring = 1; ring <= rings; ring++) {
            this.sounds.play("crumble", { delay: (ring * stepMs + 250) / 1000 });
          }
          this.later(ms || 100, () => this.finished()); // Classic: the 700ms fall is done
        });
      });
    }
    if (this.chess.inCheck()) this.sounds.play("check", opts);
    else if (move.isCapture() || move.isEnPassant()) this.sounds.play("capture", opts);
    else if (move.isKingsideCastle() || move.isQueensideCastle()) this.sounds.play("castle", opts);
    else if (move.isPromotion()) this.sounds.play("promote", opts);
    else this.sounds.play("move", opts);
  }

  private baseHighlights(move: Move) {
    let check: Square | undefined;
    if (this.chess.inCheck()) check = this.chess.findPiece({ type: "k", color: this.chess.turn() })[0];
    return { lastMove: [move.from, move.to] as [Square, Square], check };
  }

  private enableInput() {
    const dests = new Map<Square, Square[]>();
    const add = (chess: Chess) => {
      for (const m of chess.moves({ verbose: true })) {
        if (!dests.has(m.from)) dests.set(m.from, []);
        const list = dests.get(m.from)!;
        if (!list.includes(m.to)) list.push(m.to);
      }
    };
    if (this.dev) {
      // Either color may move next, except that a side in check must deal with it
      // first, and checkmate ends the game (see devMove).
      const sides = (["w", "b"] as const).map((color) => ({ color, chess: withTurn(this.chess, color) }));
      const inCheck = sides.filter((x) => x.chess.inCheck());
      const movers = inCheck.length ? inCheck : sides;
      for (const x of movers) add(x.chess);
      this.board.setMovable(movers.length === 1 ? movers[0].color : "both", dests);
    } else {
      add(this.chess);
      this.board.setMovable(this.playerColor, dests);
    }
  }

  /** Dev mode: plays any legal move for either color, with all the usual effects. */
  private devMove(from: Square, to: Square, promotion?: PieceType) {
    this.board.setMovable(null);
    const piece = this.chess.get(from as ChessSquare);
    if (piece && piece.color !== this.chess.turn()) this.chess = withTurn(this.chess, piece.color);
    let move: Move;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      this.enableInput();
      return;
    }
    this.show(move, true);
    this.board.setHighlights(this.baseHighlights(move));
    if (this.chess.isCheckmate()) {
      this.board.setMovable(null); // game over until Reset board
      this.sounds.play("solved", { delay: this.board.travelMs(move.to) / 1000 });
    } else {
      this.enableInput();
    }
    this.emit();
  }

  private runPendingRevert() {
    const revert = this.pendingRevert;
    this.pendingRevert = null;
    revert?.();
  }

  private report(solved: boolean) {
    if (this.reported || this.dev) return;
    this.reported = true;
    api
      .recordAttempt(this.puzzle.id, solved, this.usedHint)
      .then((r) => this.hooks.onResult(r))
      .catch((e) => console.error("recordAttempt failed", e));
  }

  private setStatus(status: Status) {
    this.status = status;
    this.emit();
  }

  private emit() {
    this.hooks.onChange(this.state);
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }
}

/** A copy of `chess` with `color` to move (en passant dropped, since it only applies to the real side to move). */
function withTurn(chess: Chess, color: "w" | "b"): Chess {
  const parts = chess.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  return new Chess(parts.join(" "), { skipValidation: true });
}

function position(chess: Chess): Position {
  const pos: Position = new Map();
  for (const row of chess.board()) {
    for (const p of row) if (p) pos.set(p.square, p.color + p.type);
  }
  return pos;
}

