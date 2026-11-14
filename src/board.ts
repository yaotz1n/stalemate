// Chess board view: renders a position, animates changes between positions,
// and turns clicks/drags into move requests. It knows nothing about chess
// rules; the caller supplies which moves are legal via setMovable().

import type { PieceColor, PieceSet, PieceType } from "./pieces";
import { QUALITY_NAME, QUALITY_SYMBOL, type Quality } from "./quality";
import type { Tactic, TacticDetail } from "./tactics";

export type Square = string; // "e4"
/** square -> piece code, e.g. "wq" */
export type Position = Map<Square, string>;
export type MarkKind = "good" | "bad";

export interface Highlights {
  lastMove?: [Square, Square];
  check?: Square;
  hint?: Square;
  mark?: { square: Square; kind: MarkKind };
}

export type TacticKind = Tactic;

/** Icons for tactic badges (24x24, drawn in white on a colored disc). */
export const TACTIC_ICONS: Record<TacticKind, string> = {
  // A fork in the road: one path splitting into two arrows.
  fork:
    '<path d="M12 21v-7.5L6.5 8M12 13.5 17.5 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 4.5h6.5L3.5 11zM20.5 4.5H14l6.5 6.5z" fill="currentColor"/>',
  // A push pin.
  pin: '<path d="M14.5 2.5 21.5 9.5l-1.8.6-3.3 3.3.4 4.3-1.9 1.9-4-4-5.4 5.4-1.2-1.2 5.4-5.4-4-4 1.9-1.9 4.3.4 3.3-3.3z" fill="currentColor"/>',
  // An eye: something revealed.
  discovered:
    '<path d="M12 5C6.6 5 2.8 9 1.5 12c1.3 3 5.1 7 10.5 7s9.2-4 10.5-7C21.2 9 17.4 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" fill="currentColor"/><circle cx="12" cy="12" r="2.3" fill="currentColor"/>',
  // Two plus signs: two checks at once.
  "double-check":
    '<path d="M6 3.5h2.4v3.6H12v2.4H8.4v3.6H6V9.5H2.4V7.1H6zM15.6 10.9H18v3.6h3.6v2.4H18v3.6h-2.4v-3.6H12v-2.4h3.6z" fill="currentColor"/>',
  // A crosshair: the king is in the sights.
  "mate-threat":
    '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1.8v4.4M12 17.8v4.4M1.8 12h4.4M17.8 12h4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
  // A gift box.
  "free-piece":
    '<path d="M3.5 9.5h7.7V13H3.5zM12.8 9.5h7.7V13h-7.7zM5 13h6.2v7.5H5zM12.8 13H19v7.5h-6.2z" fill="currentColor"/><path d="M12 9.3C10.5 6 7.2 5.3 7 7.4c-.2 2 3 2.1 5 1.9zm0 0c1.5-3.3 4.8-4 5-1.9.2 2-3 2.1-5 1.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  // A battery with charge bars.
  battery:
    '<rect x="3" y="7" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="19.5" y="10" width="2" height="4" rx=".6" fill="currentColor"/><rect x="5.5" y="9.5" width="3" height="5" rx=".5" fill="currentColor"/><rect x="9.5" y="9.5" width="3" height="5" rx=".5" fill="currentColor"/><rect x="13.5" y="9.5" width="3" height="5" rx=".5" fill="currentColor"/>',
  // Cage bars.
  trapped:
    '<path d="M5 5.5h14M5 19.5h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M7.5 5.5v14M12 5.5v14M16.5 5.5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  // An upside-down dagger.
  sacrifice:
    '<g transform="rotate(180 12 12)"><path d="M12 2.2 14 6v8.4h-4V6z" fill="currentColor"/><path d="M7 14.4h10v2H7z" fill="currentColor"/><path d="M11 16.4h2v3.6h-2z" fill="currentColor"/><circle cx="12" cy="21.2" r="1.4" fill="currentColor"/></g>',
  // A skewer through two beads.
  skewer:
    '<path d="M2.6 20 20 2.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8.5" cy="14" r="3.3" fill="currentColor"/><circle cx="14.5" cy="8" r="3.3" fill="currentColor"/>',
};
export const TACTIC_NAMES: Record<TacticKind, string> = {
  fork: "Fork",
  pin: "Pin",
  skewer: "Skewer",
  discovered: "Discovered attack",
  "double-check": "Double check",
  "mate-threat": "Mate threat",
  "free-piece": "Free piece",
  battery: "Battery",
  trapped: "Trapped piece",
  sacrifice: "Sacrifice",
};

export type MoveHandler = (from: Square, to: Square, promotion?: PieceType) => void;

const FILES = "abcdefgh";
const PROMOTION_CHOICES: PieceType[] = ["q", "n", "r", "b"];

export class Board {
  private root: HTMLElement;
  private squaresLayer: HTMLElement;
  private glowLayer: HTMLElement;
  private highlightLayer: HTMLElement;
  private piecesLayer: HTMLElement;
  private arrowLayer: SVGSVGElement;
  /** Arrows explaining the shown tactic badges (see renderTactics). */
  private tacticArrowLayer: SVGGElement;
  /** The hint arrow (setArrow). */
  private hintArrowLayer: SVGGElement;
  /** Whether to draw arrows for tactics. */
  private tacticArrows = true;
  private promoLayer: HTMLElement;

  private position: Position = new Map();
  private els = new Map<Square, HTMLElement>();
  private orientation: PieceColor = "w";
  private pieceSet: PieceSet;
  private animMs = 200;
  private showLegal = true;
  private showCoords = true;
  /** Click a piece, then a square, to move. Dragging always works. */
  private clickToMove = true;
  /** Arcade effects (off when animation is Off): pieces lift, hop and land, and the board builds and crumbles. */
  private arcade = false;
  /** Tint the last-move highlight with the color of that move's tactic badge. */
  private tacticHighlight = false;
  /** The tint fades in with the badge the first time it's drawn, then just stays. */
  private tintPending = false;
  /** A flipTo() in progress (the board's spin and each piece's counter-spin). */
  private flipAnims: Animation[] = [];
  private flipDone: (() => void) | null = null;
  /** Fancy animation: moving pieces arc (knights hop) and squash as they land, and the board builds and crumbles. */
  private fancy = false;
  /** Called when the player picks up (selects or starts dragging) a piece. */
  onPickup: ((code: string) => void) | null = null;

  /** Which side's pieces can be picked up ("both" in dev mode). */
  private movableColor: PieceColor | "both" | null = null;
  private dests = new Map<Square, Square[]>();
  private selected: Square | null = null;
  private highlights: Highlights = {};
  /** Tactic badges on one piece (`enemy`: the opponent's, shown in yellow); dropped once that piece leaves its square. */
  private tactic: {
    square: Square;
    code: string;
    kinds: TacticKind[];
    details: TacticDetail[];
    delayMs: number;
    enemy: boolean;
    /** The move's quality badge (in the corner of the row); null for none. */
    quality: Quality | null;
    /** For a mistake or blunder: the move that would have been best, drawn as a green arrow. */
    betterMove: [Square, Square] | null;
  } | null = null;
  private drag: { from: Square; el: HTMLElement; startX: number; startY: number; active: boolean; wasSelected: boolean } | null = null;
  private dropped: Square | null = null;

  constructor(container: HTMLElement, pieceSet: PieceSet, private onMove: MoveHandler) {
    this.pieceSet = pieceSet;
    this.root = el("div", "board");
    this.squaresLayer = el("div", "board-squares");
    this.glowLayer = el("div", "board-glow");
    this.highlightLayer = el("div", "board-highlights");
    this.piecesLayer = el("div", "board-pieces");
    this.arrowLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.arrowLayer.classList.add("board-arrows");
    this.arrowLayer.setAttribute("viewBox", "0 0 800 800");
    this.tacticArrowLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.hintArrowLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.arrowLayer.append(this.tacticArrowLayer, this.hintArrowLayer);
    this.promoLayer = el("div", "board-promo");
    this.root.append(
      this.squaresLayer,
      this.glowLayer,
      this.highlightLayer,
      this.piecesLayer,
      this.arrowLayer,
      this.promoLayer,
    );
    container.append(this.root);

    this.root.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.root.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.root.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.root.addEventListener("pointercancel", () => this.cancelDrag());
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.drawSquares();
  }

  // ---- configuration ----

  setPieceSet(set: PieceSet) {
    this.pieceSet = set;
    for (const [sq, node] of this.els) this.setImage(node, this.position.get(sq)!);
  }

  setOrientation(color: PieceColor) {
    this.flipDone?.(); // finish a flip in progress first
    if (color === this.orientation) return;
    this.orientation = color;
    this.drawSquares();
    for (const [sq, node] of this.els) this.place(node, sq);
    this.renderHighlights();
    this.renderTactics();
  }

  /**
   * Turns the board to `color`'s side with a half spin (pieces stay upright),
   * instead of the pieces sliding across. Instant with animation off.
   */
  flipTo(color: PieceColor) {
    this.flipDone?.(); // jump to the end of a flip still in progress
    if (color === this.orientation) return;
    if (this.animMs === 0) {
      this.setOrientation(color);
      return;
    }
    const timing: KeyframeAnimationOptions = { duration: 520, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" };
    const spin = this.root.animate([{ rotate: "0deg" }, { rotate: "180deg" }], timing);
    // Pieces turn the other way around their own centers, so they stay upright on their squares while the board
    // turns. (The rotation goes after the piece's translate; the separate `rotate` property would come before it
    // and swing pieces around the board's corner.)
    this.flipAnims = [
      spin,
      ...[...this.els].map(([sq, n]) => {
        const [col, row] = this.coords(sq);
        const at = `translate(${col * 100}%, ${row * 100}%)`;
        return n.animate([{ transform: `${at} rotate(0deg)` }, { transform: `${at} rotate(-180deg)` }], timing);
      }),
    ];
    this.flipDone = () => {
      // The spun board now looks exactly like the other side's view: switch to it without any movement.
      this.flipDone = null;
      for (const node of this.els.values()) this.withoutTransition(node);
      this.setOrientation(color);
      this.flipAnims.forEach((a) => a.cancel());
      this.flipAnims = [];
    };
    spin.onfinish = () => this.flipDone?.();
  }

  setOptions(opts: { animMs?: number; showLegal?: boolean; showCoords?: boolean; clickToMove?: boolean; arcade?: boolean; fancy?: boolean; tacticHighlight?: boolean; tacticArrows?: boolean }) {
    if (opts.tacticArrows !== undefined && opts.tacticArrows !== this.tacticArrows) {
      this.tacticArrows = opts.tacticArrows;
      this.renderTactics();
    }
    if (opts.tacticHighlight !== undefined) this.tacticHighlight = opts.tacticHighlight;
    if (opts.fancy !== undefined) {
      this.fancy = opts.fancy;
      this.root.classList.toggle("fancy", opts.fancy);
    }
    if (opts.arcade !== undefined) {
      this.arcade = opts.arcade;
      this.root.classList.toggle("arcade", opts.arcade);
    }
    if (opts.animMs !== undefined) {
      this.animMs = opts.animMs;
      this.root.style.setProperty("--anim-ms", `${opts.animMs}ms`);
      this.root.classList.toggle("no-motion", opts.animMs === 0);
    }
    if (opts.showLegal !== undefined) this.showLegal = opts.showLegal;
    if (opts.clickToMove !== undefined) this.clickToMove = opts.clickToMove;
    if (opts.showCoords !== undefined) {
      this.showCoords = opts.showCoords;
      this.drawSquares();
    }
    this.renderHighlights();
  }

  setMovable(color: PieceColor | "both" | null, dests: Map<Square, Square[]> = new Map()) {
    this.movableColor = color;
    this.dests = dests;
    if (this.selected && !dests.has(this.selected)) this.selected = null;
    this.root.classList.toggle("interactive", color !== null);
    this.renderHighlights();
  }

  setHighlights(h: Highlights) {
    this.highlights = h;
    this.renderHighlights();
  }

  /**
   * Shows tactic badges (fork, pin, skewer) on the piece on `square`, popping in
   * after `delayMs` (e.g. once the move lands). They stay until that piece moves
   * or is captured, or until this is called again; pass null to clear.
   */
  setTactics(
    square: Square | null,
    details: TacticDetail[] = [],
    delayMs = 0,
    enemy = false,
    quality: Quality | null = null,
    betterMove: [Square, Square] | null = null,
  ) {
    const code = square ? this.position.get(square) : undefined;
    const kinds = [...new Set(details.map((d) => d.kind))];
    this.tactic = square && code && (kinds.length || quality) ? { square, code, kinds, details, delayMs, enemy, quality, betterMove } : null;
    this.tintPending = !!this.tactic;
    this.renderTactics();
    this.renderHighlights();
  }

  private renderTactics() {
    this.piecesLayer.querySelectorAll(".tactic").forEach((n) => n.remove());
    this.tacticArrowLayer.innerHTML = "";
    const t = this.tactic;
    if (!t) return;
    // Arrows in each tactic's color (yellow for the opponent's) showing who attacks what,
    // and a green one for the better move after a mistake or blunder.
    if (this.tacticArrows || t.betterMove) {
      const shown = new Set(this.tacticArrows ? t.kinds : []);
      const seen = new Set<string>();
      const arrows: { from: Square; to: Square; cls: string }[] = [];
      for (const d of t.details) {
        if (!shown.has(d.kind)) continue;
        for (const [from, to] of d.arrows) {
          const cls = `tactic-arrow ${t.enemy ? "enemy" : d.kind}`;
          if (from === to || seen.has(from + to + cls)) continue;
          seen.add(from + to + cls);
          arrows.push({ from, to, cls });
        }
      }
      // What should have been played, after a mistake or blunder (drawn even with tactic arrows off: see below).
      if (t.betterMove) arrows.push({ from: t.betterMove[0], to: t.betterMove[1], cls: "tactic-arrow better-move" });
      const shifts = this.sideBySide(arrows);
      this.tacticArrowLayer.innerHTML = arrows.map((a, i) => this.arrowSvg(a.from, a.to, 12, 28, 18, a.cls, shifts[i])).join("");
      this.tacticArrowLayer.querySelectorAll<SVGGElement>(".tactic-arrow").forEach((g) => (g.style.animationDelay = `${t.delayMs}ms`));
    }
    const node = this.squareDiv(t.square, t.enemy ? "tactic enemy" : "tactic");
    // Side by side, popping in left to right; the move's quality badge takes the
    // corner, then the most striking tactic (first in `kinds`) next to it.
    const n = t.kinds.length + (t.quality ? 1 : 0);
    [...t.kinds].reverse().forEach((kind, i) => {
      const badge = el("span", `tactic-badge ${kind}`);
      badge.style.setProperty("--i", String(i));
      badge.style.setProperty("--n", String(n));
      badge.style.zIndex = String(i);
      badge.style.animationDelay = `${t.delayMs + i * 90}ms`;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", TACTIC_NAMES[kind]);
      badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${TACTIC_ICONS[kind]}</svg>`;
      node.append(badge);
    });
    if (t.quality) {
      const i = n - 1;
      const badge = el("span", `tactic-badge quality-badge ${t.quality}`, QUALITY_SYMBOL[t.quality]);
      badge.style.setProperty("--i", String(i));
      badge.style.setProperty("--n", String(n));
      badge.style.animationDelay = `${t.delayMs + i * 90}ms`;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", QUALITY_NAME[t.quality]);
      node.append(badge);
    }
    this.piecesLayer.append(node); // above pieces
  }

  /** Tips the piece on `square` over (a checkmated king). Cleared by the next setPosition. */
  /** A snapshot of what the board is showing, for the dev "Copy game state" button. */
  debugState() {
    return {
      orientation: this.orientation,
      position: Object.fromEntries(this.position),
      movable: this.movableColor,
      selected: this.selected,
      highlights: this.highlights,
      tacticBadges: this.tactic && { square: this.tactic.square, piece: this.tactic.code, details: this.tactic.details },
      animMs: this.animMs,
      arcade: this.arcade,
    };
  }

  /** Puzzles: tactic badges shift left to leave the corner to the ✓/✕ mark. */
  setMarkSlot(reserve: boolean) {
    this.root.classList.toggle("mark-slot", reserve);
  }

  setFallen(square: Square | null) {
    for (const node of this.els.values()) node.classList.remove("fallen");
    if (square) this.els.get(square)?.classList.add("fallen");
  }

  /**
   * Game over: a green badge with a king on the winner's king and a red one
   * with a king lying on its side on the loser's, popping in after
   * `delayMs`. Pass null to clear.
   */
  setResult(result: { win: Square; lose: Square; how: "mate" | "resign" } | null, delayMs = 0) {
    this.piecesLayer.querySelectorAll(".result").forEach((n) => n.remove());
    if (!result) return;
    // The Cburnett king in one flat color (inner lines in the badge's color):
    // upright for the winner, lying on its side for the loser.
    const king =
      '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path stroke-linejoin="miter" d="M22.5 11.63V6M20 8h5"/>' +
      '<path fill="currentColor" stroke-linecap="butt" stroke-linejoin="miter" d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/>' +
      '<path fill="currentColor" d="M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7"/>' +
      '<path class="king-lines" d="M32 29.5s8.5-4 6.03-9.65C34.15 14 25 18 22.5 24.5v2.1-2.1C20 18 10.85 14 6.97 19.85 4.5 25.5 13 29.5 13 29.5M12.5 30c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0"/>' +
      "</g>";
    const icons = {
      win: king,
      lose: `<g transform="rotate(90 22.5 22.5)">${king}</g>`,
    };
    for (const [sq, kind, icon, label] of [
      [result.win, "win", icons.win, "Winner"],
      [result.lose, "lose", icons.lose, result.how === "mate" ? "Checkmated" : "Resigned"],
    ] as const) {
      const node = this.squareDiv(sq, `result ${kind}`);
      const badge = el("span", "result-badge");
      badge.style.animationDelay = `${delayMs}ms`;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", label);
      badge.innerHTML = `<svg viewBox="0 0 45 45" aria-hidden="true">${icon}</svg>`;
      node.append(badge);
      this.piecesLayer.append(node);
    }
  }

  /** Briefly glows `square` (fades in, then out). Cleared by a non-animated setPosition. */
  glow(square: Square) {
    this.glowLayer.innerHTML = "";
    const node = this.squareDiv(square, "square-glow");
    node.addEventListener("animationend", () => node.remove(), { once: true });
    this.glowLayer.append(node);
  }

  /** How long a move onto `to` takes to land (0 if the piece was dropped there by dragging). */
  travelMs(to: Square) {
    return this.dropped === to ? 0 : this.animMs;
  }

  /**
   * Fancy animation: tiles (and their pieces) pop in ring by ring, spreading out from
   * `origins`. Returns how long it takes and how many rings there are, or
   * zeros unless animation is Fancy.
   */
  build(origins: Square[]): { ms: number; rings: number; stepMs: number } {
    const stepMs = 55;
    if (!this.fancy || this.animMs === 0 || origins.length === 0) return { ms: 0, rings: 0, stepMs };
    let rings = 0;
    const delay = (sq: Square) => {
      const d = Math.min(...origins.map((o) => chebyshev(o, sq)));
      rings = Math.max(rings, d);
      return `${d * stepMs}ms`;
    };
    for (const node of this.squaresLayer.children as HTMLCollectionOf<HTMLElement>) {
      node.style.setProperty("--d", delay(node.dataset.square!));
    }
    for (const [sq, node] of this.els) node.style.setProperty("--d", delay(sq));
    this.root.classList.remove("building");
    void this.root.offsetWidth;
    this.root.classList.add("building");
    const ms = rings * stepMs + 340;
    window.setTimeout(() => this.root.classList.remove("building"), ms);
    return { ms, rings, stepMs };
  }

  /**
   * Fancy animation: the board falls apart around `center`, nearest tiles first, each
   * taking its piece with it; the tile under `center` (and its fallen king)
   * goes last. Returns the duration and ring count (zeros unless animation is Fancy).
   */
  crumble(center: Square): { ms: number; rings: number; stepMs: number } {
    const stepMs = 60;
    if (!this.fancy || this.animMs === 0) return { ms: 0, rings: 0, stepMs };
    const fall = this.root.getBoundingClientRect().height;
    const squares = [...(this.squaresLayer.children as HTMLCollectionOf<HTMLElement>)];
    const outer = Math.max(...squares.map((n) => chebyshev(center, n.dataset.square!)));
    const ringOf = (sq: Square) => (sq === center ? outer + 1 : chebyshev(center, sq));
    const drop = (node: HTMLElement, sq: Square) => {
      const extra = sq === center ? 150 : Math.random() * 50;
      node.style.setProperty("--d", `${ringOf(sq) * stepMs + extra}ms`);
      const drift = (Math.random() * 2 - 1) * 40;
      const down = fall * (0.7 + Math.random() * 0.4);
      // A tipped-over king is rotated 90deg, so "down" on screen is +x in its own frame.
      const tipped = node.classList.contains("fallen");
      node.style.setProperty("--fx", `${tipped ? down : drift}px`);
      node.style.setProperty("--fy", `${tipped ? -drift : down}px`);
      node.style.setProperty("--fr", `${(Math.random() * 2 - 1) * 50}deg`);
      node.classList.add("falling");
    };
    for (const node of squares) drop(node, node.dataset.square!);
    for (const [sq, node] of this.els) drop(node, sq);
    this.root.classList.add("crumbling");
    const rings = outer + 1;
    return { ms: rings * stepMs + 150 + 800, rings, stepMs };
  }

  setArrow(from: Square | null, to?: Square) {
    this.hintArrowLayer.innerHTML = from && to ? this.arrowSvg(from, to, 16, 34, 22) : "";
  }

  /**
   * Shifts for arrows that would overlap (on the same line, with overlapping
   * stretches): each such group is spread out side by side, a small gap apart,
   * across the line. Others stay put.
   */
  private sideBySide(arrows: { from: Square; to: Square }[]): [number, number][] {
    const seg = arrows.map((a) => [...this.center(a.from), ...this.center(a.to)]);
    const group = arrows.map((_, i) => i);
    const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
    for (let i = 0; i < seg.length; i++) {
      for (let j = i + 1; j < seg.length; j++) {
        const [ax, ay, bx, by] = seg[i];
        const [cx, cy, dx, dy] = seg[j];
        const ux = bx - ax;
        const uy = by - ay;
        const len = Math.hypot(ux, uy);
        // Both ends of j on i's line?
        const off = (px: number, py: number) => Math.abs((px - ax) * uy - (py - ay) * ux) / len;
        if (off(cx, cy) > 1 || off(dx, dy) > 1) continue;
        // Overlapping stretches along that line (more than just touching ends)?
        const t = (px: number, py: number) => ((px - ax) * ux + (py - ay) * uy) / len;
        const [lo, hi] = [Math.min(t(cx, cy), t(dx, dy)), Math.max(t(cx, cy), t(dx, dy))];
        if (Math.min(hi, len) - Math.max(lo, 0) > 1) group[root(j)] = root(i);
      }
    }
    const shifts: [number, number][] = arrows.map(() => [0, 0]);
    const members = new Map<number, number[]>();
    arrows.forEach((_, i) => members.set(root(i), [...(members.get(root(i)) ?? []), i]));
    const step = 16; // arrow width 12 + a small gap
    for (const [first, list] of members) {
      if (list.length < 2) continue;
      const [ax, ay, bx, by] = seg[first];
      const len = Math.hypot(bx - ax, by - ay);
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      list.forEach((i, k) => {
        const o = (k - (list.length - 1) / 2) * step;
        shifts[i] = [nx * o, ny * o];
      });
    }
    return shifts;
  }

  /** An arrow from the center of `from` to the center of `to` (SVG, 800-unit board), shifted by `shift`. */
  private arrowSvg(from: Square, to: Square, width: number, head: number, half: number, cls = "", shift: [number, number] = [0, 0]) {
    const [x1, y1] = this.center(from).map((v, i) => v + shift[i]);
    const [x2, y2] = this.center(to).map((v, i) => v + shift[i]);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const ex = x2 - ux * head;
    const ey = y2 - uy * head;
    const px = -uy * half;
    const py = ux * half;
    return (
      `<g class="${cls}"><line class="arrow" x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width="${width}" stroke-linecap="round"/>` +
      `<polygon class="arrow-head" points="${x2},${y2} ${ex + px},${ey + py} ${ex - px},${ey - py}"/></g>`
    );
  }

  // ---- position ----

  /**
   * Shows `next`, animating pieces from where they were. `lastMove` tells
   * which piece moved so promotions slide (then change) instead of fading.
   */
  setPosition(next: Position, opts: { animate?: boolean; lastMove?: [Square, Square] } = {}) {
    const animate = !!opts.animate && this.animMs > 0;
    const prev = this.position;
    const leftover = new Map(this.els);
    const nextEls = new Map<Square, HTMLElement>();
    const needed: [Square, string][] = [];

    for (const [sq, code] of next) {
      const node = leftover.get(sq);
      if (node && prev.get(sq) === code) {
        nextEls.set(sq, node);
        leftover.delete(sq);
      } else {
        needed.push([sq, code]);
      }
    }

    const move = (node: HTMLElement, to: Square, code: string) => {
      this.setImage(node, code);
      if (animate && this.dropped !== to) {
        node.classList.add("moving");
        window.setTimeout(() => node.classList.remove("moving"), this.animMs);
        if (this.arcade && this.fancy) this.hop(node, code);
      } else {
        this.withoutTransition(node);
        if (this.arcade && this.fancy && this.dropped === to) this.land(node);
      }
      this.place(node, to);
      nextEls.set(to, node);
    };

    if (opts.lastMove) {
      const [from, to] = opts.lastMove;
      const node = leftover.get(from);
      const i = needed.findIndex(([sq]) => sq === to);
      if (node && i >= 0) {
        leftover.delete(from);
        move(node, to, needed[i][1]);
        needed.splice(i, 1);
      }
    }

    for (const [sq, code] of needed) {
      let best: Square | null = null;
      let bestDist = Infinity;
      for (const osq of leftover.keys()) {
        if (prev.get(osq) !== code) continue;
        const d = distance(osq, sq);
        if (d < bestDist) {
          best = osq;
          bestDist = d;
        }
      }
      if (best) {
        const node = leftover.get(best)!;
        leftover.delete(best);
        move(node, sq, code);
      } else {
        const node = this.makePiece(code);
        this.place(node, sq);
        if (animate) {
          node.classList.add("appearing");
          requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("appearing")));
        }
        this.piecesLayer.append(node);
        nextEls.set(sq, node);
      }
    }

    for (const node of leftover.values()) {
      if (animate) {
        node.classList.add("captured");
        window.setTimeout(() => node.remove(), this.animMs + 50);
      } else {
        node.remove();
      }
    }

    this.dropped = null;
    this.setFallen(null);
    if (!opts.animate) {
      this.glowLayer.innerHTML = "";
      this.root.classList.remove("crumbling", "building");
      for (const n of this.squaresLayer.children) n.classList.remove("falling");
      for (const n of nextEls.values()) n.classList.remove("falling");
    }
    this.position = new Map(next);
    this.els = nextEls;
    if (this.tactic && next.get(this.tactic.square) !== this.tactic.code) {
      this.tactic = null;
      this.renderTactics();
    }
    if (this.selected && !next.has(this.selected)) this.selected = null;
    this.renderHighlights();
  }

  // ---- input ----

  private pointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.promoLayer.classList.contains("open")) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq || this.movableColor === null) return;

    if (this.clickToMove && this.selected && this.selected !== sq && this.dests.get(this.selected)?.includes(sq)) {
      this.tryMove(this.selected, sq);
      return;
    }
    const code = this.position.get(sq);
    if (code && (this.movableColor === "both" || code[0] === this.movableColor) && this.dests.has(sq)) {
      const wasSelected = this.selected === sq;
      this.selected = sq;
      if (!wasSelected) this.onPickup?.(code);
      this.drag = { from: sq, el: this.els.get(sq)!, startX: e.clientX, startY: e.clientY, active: false, wasSelected };
      // The piece jumps to the pointer right away; it only counts as a drag once
      // the pointer has moved 4px (a release before that is a click).
      this.followPointer(this.drag.el, e);
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events (tests) have no capturable pointer.
      }
      this.renderHighlights();
    } else if (this.selected) {
      this.selected = null;
      this.renderHighlights();
    }
  }

  private pointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.followPointer(d.el, e);
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.active = true;
    const over = this.squareAt(e.clientX, e.clientY);
    this.highlightLayer.querySelectorAll(".drag-over").forEach((n) => n.remove());
    if (over && this.dests.get(d.from)?.includes(over)) {
      this.highlightLayer.append(this.squareDiv(over, "drag-over"));
    }
  }

  private pointerUp(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.highlightLayer.querySelectorAll(".drag-over").forEach((n) => n.remove());
    if (!d.active) {
      // A click: the piece goes straight back to its square.
      d.el.classList.remove("dragging");
      this.withoutTransition(d.el);
      this.place(d.el, d.from);
      // A plain click keeps the piece selected only in click-to-move mode.
      if (d.wasSelected || !this.clickToMove) {
        this.selected = null;
        this.renderHighlights();
      }
      return;
    }
    d.el.classList.remove("dragging");
    const to = this.squareAt(e.clientX, e.clientY);
    if (to && to !== d.from && this.dests.get(d.from)?.includes(to)) {
      this.dropped = to;
      this.withoutTransition(d.el);
      this.place(d.el, to);
      this.tryMove(d.from, to);
    } else {
      // Dropped back home or on a square it can't go to: it snaps straight back
      // (Fancy: floats back). In click-to-move mode it stays selected if dropped
      // on its own square, so a click can finish the move; otherwise it's deselected.
      if (!this.fancy) this.withoutTransition(d.el);
      this.place(d.el, d.from);
      if (!(this.clickToMove && to === d.from)) {
        this.selected = null;
        this.renderHighlights();
      }
    }
  }

  /** Centers a held piece on the pointer. */
  private followPointer(node: HTMLElement, e: PointerEvent) {
    const rect = this.root.getBoundingClientRect();
    const size = rect.width / 8;
    node.classList.add("dragging");
    // Scale inside the transform (after the move), so it grows around the pointer.
    node.style.transform = `translate(${e.clientX - rect.left - size / 2}px, ${e.clientY - rect.top - size / 2}px) scale(var(--held-scale, 1))`;
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.drag.el.classList.remove("dragging");
    if (!this.fancy) this.withoutTransition(this.drag.el);
    this.place(this.drag.el, this.drag.from);
    this.selected = null;
    this.renderHighlights();
    this.drag = null;
  }

  private tryMove(from: Square, to: Square) {
    this.selected = null;
    this.renderHighlights();
    const code = this.position.get(from)!;
    const lastRank = code[0] === "w" ? "8" : "1";
    if (code[1] === "p" && to[1] === lastRank) {
      this.askPromotion(from, to, code[0] as PieceColor);
    } else {
      this.onMove(from, to);
    }
  }

  private askPromotion(from: Square, to: Square, color: PieceColor) {
    const [col, row] = this.coords(to);
    const downward = row === 0;
    this.promoLayer.innerHTML = "";
    PROMOTION_CHOICES.forEach((type, i) => {
      const btn = el("button", "promo-choice");
      btn.style.backgroundImage = this.pieceUrl(color + type);
      btn.style.left = `${col * 12.5}%`;
      btn.style.top = `${(downward ? row + i : row - i) * 12.5}%`;
      btn.title = { q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[type as "q" | "n" | "r" | "b"];
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.closePromotion();
        this.onMove(from, to, type);
      });
      this.promoLayer.append(btn);
    });
    this.promoLayer.classList.add("open");
    this.promoLayer.onpointerdown = (e) => {
      if (e.target === this.promoLayer) {
        e.stopPropagation();
        this.closePromotion();
        const node = this.els.get(from);
        if (node) this.place(node, from);
      }
    };
  }

  private closePromotion() {
    this.promoLayer.classList.remove("open");
    this.promoLayer.innerHTML = "";
  }

  // ---- rendering helpers ----

  private drawSquares() {
    this.squaresLayer.innerHTML = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareFromCoords(col, row);
        const fileIdx = FILES.indexOf(sq[0]);
        const rank = Number(sq[1]);
        const node = el("div", `square ${(fileIdx + rank) % 2 === 0 ? "light" : "dark"}`);
        node.dataset.square = sq;
        if (this.showCoords) {
          if (row === 7) node.append(el("span", "coord file", sq[0]));
          if (col === 0) node.append(el("span", "coord rank", sq[1]));
        }
        this.squaresLayer.append(node);
      }
    }
  }

  private renderHighlights() {
    const h = this.highlights;
    const layer = this.highlightLayer;
    layer.innerHTML = "";
    // With the option on, a move with tactic badges takes the main badge's color (yellow for the opponent's).
    const t = this.tactic;
    const tint = this.tacticHighlight && t && t.kinds.length && h.lastMove?.[1] === t.square ? (t.enemy ? "enemy" : t.kinds[0]) : null;
    if (h.lastMove) {
      for (const sq of h.lastMove) {
        const node = this.squareDiv(sq, tint ? `last-move tinted ${tint}` : "last-move");
        if (tint && this.tintPending) node.style.animationDelay = `${t!.delayMs}ms`;
        else if (tint) node.style.animation = "none";
        layer.append(node);
      }
      if (tint) this.tintPending = false;
    }
    // A king in check gets a red "+" badge (above the pieces, like the other badges).
    // Kept while the same king stays in check, so redraws (e.g. selecting a piece) don't pop it in again.
    const current = this.piecesLayer.querySelector<HTMLElement>(".check-badge-node");
    if (current && current.dataset.check !== h.check) current.remove();
    else if (current && h.check) this.place(current, h.check); // e.g. after the board flips
    if (h.check && !(current && current.dataset.check === h.check)) {
      const node = this.squareDiv(h.check, "check-badge-node");
      node.dataset.check = h.check;
      const badge = el("span", "check-badge");
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", "Check");
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 4.5h2.8v6.1h6.1v2.8h-6.1v6.1h-2.8v-6.1H4.5v-2.8h6.1z" fill="currentColor"/></svg>';
      node.append(badge);
      this.piecesLayer.append(node);
    }
    if (h.hint) layer.append(this.squareDiv(h.hint, "hint"));
    if (this.selected) {
      layer.append(this.squareDiv(this.selected, "selected"));
      if (this.showLegal) {
        for (const to of this.dests.get(this.selected) ?? []) {
          layer.append(this.squareDiv(to, this.position.has(to) ? "dest capture" : "dest"));
        }
      }
    }
    if (h.mark) {
      const node = this.squareDiv(h.mark.square, `mark ${h.mark.kind}`);
      node.append(el("span", "mark-badge", h.mark.kind === "good" ? "✓" : "✕"));
      this.piecesLayer.append(node); // above pieces
      this.piecesLayer.querySelectorAll(".mark").forEach((n) => n !== node && n.remove());
    } else {
      this.piecesLayer.querySelectorAll(".mark").forEach((n) => n.remove());
    }
  }

  private squareDiv(sq: Square, cls: string) {
    const node = el("div", `hl ${cls}`);
    this.place(node, sq);
    return node;
  }

  private makePiece(code: string) {
    const node = el("div", "piece");
    node.append(el("div", "pi")); // inner image: arcade lift/hop/land effects animate this
    this.setImage(node, code);
    return node;
  }

  /** Without arcade effects the image is drawn on the piece itself; with them, on its inner element (via --img). */
  private setImage(node: HTMLElement, code: string) {
    const url = this.pieceUrl(code);
    node.style.backgroundImage = url;
    node.style.setProperty("--img", url);
  }

  private hop(node: HTMLElement, code: string) {
    const inner = node.firstElementChild as HTMLElement;
    inner.classList.remove("hop", "hop-knight", "land");
    void inner.offsetWidth; // restart the animation
    inner.classList.add(code[1] === "n" ? "hop-knight" : "hop");
    window.setTimeout(() => {
      inner.classList.remove("hop", "hop-knight");
      this.land(node);
    }, this.animMs);
  }

  private land(node: HTMLElement) {
    const inner = node.firstElementChild as HTMLElement;
    inner.classList.remove("land");
    void inner.offsetWidth;
    inner.classList.add("land");
    window.setTimeout(() => inner.classList.remove("land"), 260);
  }

  private pieceUrl(code: string) {
    return this.pieceSet.url(code[0] as PieceColor, code[1] as PieceType);
  }

  private place(node: HTMLElement, sq: Square) {
    const [col, row] = this.coords(sq);
    node.dataset.square = sq;
    // --tilt lets a piece rotate in place (see .fallen) without losing its square.
    node.style.transform = `translate(${col * 100}%, ${row * 100}%) rotate(var(--tilt, 0deg))`;
  }

  private withoutTransition(node: HTMLElement) {
    node.classList.add("no-anim");
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("no-anim")));
  }

  private coords(sq: Square): [number, number] {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]) - 1;
    return this.orientation === "w" ? [f, 7 - r] : [7 - f, r];
  }

  private squareFromCoords(col: number, row: number): Square {
    return this.orientation === "w" ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  private center(sq: Square): [number, number] {
    const [col, row] = this.coords(sq);
    return [col * 100 + 50, row * 100 + 50];
  }

  private squareAt(x: number, y: number): Square | null {
    const rect = this.root.getBoundingClientRect();
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.squareFromCoords(col, row);
  }
}

function chebyshev(a: Square, b: Square) {
  return Math.max(Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])), Math.abs(Number(a[1]) - Number(b[1])));
}

function distance(a: Square, b: Square) {
  return Math.hypot(FILES.indexOf(a[0]) - FILES.indexOf(b[0]), Number(a[1]) - Number(b[1]));
}

function el(tag: string, cls: string, text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text) node.textContent = text;
  return node;
}
