// Chess board view: renders a position, animates changes between positions,
// and turns clicks/drags into move requests. It knows nothing about chess
// rules; the caller supplies which moves are legal via setMovable().

import type { PieceColor, PieceSet, PieceType } from "./pieces";

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
  /** Arcade style: pieces lift, hop and land, and the board builds and crumbles. */
  private arcade = false;
  /** Called when the player picks up (selects or starts dragging) a piece. */
  onPickup: ((code: string) => void) | null = null;

  /** Which side's pieces can be picked up ("both" in dev mode). */
  private movableColor: PieceColor | "both" | null = null;
  private dests = new Map<Square, Square[]>();
  private selected: Square | null = null;
  private highlights: Highlights = {};
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
    if (color === this.orientation) return;
    this.orientation = color;
    this.drawSquares();
    for (const [sq, node] of this.els) this.place(node, sq);
    this.renderHighlights();
  }

  setOptions(opts: { animMs?: number; showLegal?: boolean; showCoords?: boolean; clickToMove?: boolean; arcade?: boolean }) {
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

  /** Tips the piece on `square` over (a checkmated king). Cleared by the next setPosition. */
  setFallen(square: Square | null) {
    for (const node of this.els.values()) node.classList.remove("fallen");
    if (square) this.els.get(square)?.classList.add("fallen");
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
   * Arcade: tiles (and their pieces) pop in ring by ring, spreading out from
   * `origins`. Returns how long it takes and how many rings there are, or
   * zeros in Classic style or with animation turned off.
   */
  build(origins: Square[]): { ms: number; rings: number; stepMs: number } {
    const stepMs = 55;
    if (!this.arcade || this.animMs === 0 || origins.length === 0) return { ms: 0, rings: 0, stepMs };
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
   * Arcade: the board falls apart around `center`, nearest tiles first, each
   * taking its piece with it; the tile under `center` (and its fallen king)
   * goes last. Returns the duration and ring count (zeros in Classic style).
   */
  crumble(center: Square): { ms: number; rings: number; stepMs: number } {
    const stepMs = 60;
    if (!this.arcade || this.animMs === 0) return { ms: 0, rings: 0, stepMs };
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
    this.arrowLayer.innerHTML = "";
    if (!from || !to) return;
    const [x1, y1] = this.center(from);
    const [x2, y2] = this.center(to);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const head = 34;
    const ex = x2 - ux * head;
    const ey = y2 - uy * head;
    const px = -uy * 22;
    const py = ux * 22;
    this.arrowLayer.innerHTML =
      `<line class="arrow" x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width="16" stroke-linecap="round"/>` +
      `<polygon class="arrow-head" points="${x2},${y2} ${ex + px},${ey + py} ${ex - px},${ey - py}"/>`;
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
        if (this.arcade) this.hop(node, code);
      } else {
        this.withoutTransition(node);
        if (this.arcade && this.dropped === to) this.land(node);
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
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.active = true;
    const rect = this.root.getBoundingClientRect();
    const size = rect.width / 8;
    d.el.classList.add("dragging");
    d.el.style.transform = `translate(${e.clientX - rect.left - size / 2}px, ${e.clientY - rect.top - size / 2}px)`;
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
      // Dropped back home: in click-to-move mode the piece stays selected so a
      // click can finish the move. Otherwise (or on an illegal square) deselect.
      this.place(d.el, d.from);
      if (!(this.clickToMove && to === d.from)) {
        this.selected = null;
        this.renderHighlights();
      }
    }
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.drag.el.classList.remove("dragging");
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
    for (const [sq, node] of this.els) node.classList.toggle("lifted", this.arcade && sq === this.selected);
    if (h.lastMove) for (const sq of h.lastMove) layer.append(this.squareDiv(sq, "last-move"));
    if (h.check) layer.append(this.squareDiv(h.check, "check"));
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

  /** Classic draws the image on the piece itself; arcade on its inner element (via --img). */
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
