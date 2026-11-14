// Short text codes for finished games, to move them between installs (e.g.
// from the browser preview to the desktop app). A code holds one or more
// games; each move is one byte: its index among the legal moves (sorted), so
// a 40-move game is about 120 characters. Engine grades, tactics and the like
// aren't included: they're worked out again on the other side.
//
// Code: "SM1." + base64url of the games back to back. Each game:
//   byte 0   bit 0: player is Black, bits 1-3: bot level, bit 4: custom start position
//   byte 1   bits 0-1: winner (0 draw, 1 White, 2 Black), bits 2-4: reason
//   2-5      when it ended, in minutes since 1970 (big-endian)
//   6        takebacks (up to 255)
//   [custom start position: 1 length byte, then the FEN]
//   7-8      number of moves (big-endian), then one byte per move

import { Chess } from "chess.js";
import type { GameResult } from "./game";
import { START_FEN } from "./game";
import type { GameRecord } from "./stats";

const PREFIX = "SM1.";
const REASONS: GameResult["reason"][] = ["checkmate", "resignation", "stalemate", "repetition", "insufficient material", "50-move rule"];

/** The legal moves in a fixed order (UCI), so a move can be stored as its index. */
function legalUci(chess: Chess): string[] {
  return chess
    .moves({ verbose: true })
    .map((m) => m.from + m.to + (m.promotion ?? ""))
    .sort();
}

function encodeGame(g: GameRecord, out: number[]) {
  const custom = g.fen !== START_FEN;
  out.push((g.playerColor === "b" ? 1 : 0) | ((g.level & 7) << 1) | (custom ? 16 : 0));
  const winner = g.result.winner === null ? 0 : g.result.winner === "w" ? 1 : 2;
  out.push(winner | (Math.max(0, REASONS.indexOf(g.result.reason as GameResult["reason"])) << 2));
  const minutes = Math.floor(new Date(g.date).getTime() / 60000);
  out.push((minutes >>> 24) & 255, (minutes >>> 16) & 255, (minutes >>> 8) & 255, minutes & 255);
  out.push(Math.min(255, g.summary.takebacks));
  if (custom) {
    out.push(g.fen.length);
    for (const ch of g.fen) out.push(ch.charCodeAt(0));
  }
  out.push((g.moves.length >> 8) & 255, g.moves.length & 255);
  const chess = new Chess(g.fen);
  for (const uci of g.moves) {
    const i = legalUci(chess).indexOf(uci);
    if (i < 0) throw new Error(`illegal move ${uci} in game ${g.id}`);
    out.push(i);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
}

/** A code for these finished games. */
export function encodeGames(games: GameRecord[]): string {
  const bytes: number[] = [];
  for (const g of games) encodeGame(g, bytes);
  const bin = String.fromCharCode(...bytes);
  return PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A game read back from a code: enough to replay it and to rebuild its record. */
export interface DecodedGame {
  fen: string;
  moves: string[];
  playerColor: "w" | "b";
  level: number;
  result: GameResult;
  date: string;
  takebacks: number;
}

/** Reads the games from one or more codes (separated by spaces or new lines). Throws if a code is damaged. */
export function decodeGames(text: string): DecodedGame[] {
  const games: DecodedGame[] = [];
  for (const code of text.split(/\s+/).filter(Boolean)) {
    if (!code.startsWith(PREFIX)) throw new Error("That doesn't look like a game code (they start with SM1.)");
    const b64 = code.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    let bin: string;
    try {
      bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    } catch {
      throw new Error("That game code is damaged (check it was copied in full)");
    }
    const bytes = Array.from(bin, (c) => c.charCodeAt(0));
    let p = 0;
    const next = () => {
      if (p >= bytes.length) throw new Error("That game code is cut short (check it was copied in full)");
      return bytes[p++];
    };
    while (p < bytes.length) {
      const flags = next();
      const res = next();
      const minutes = ((next() << 24) | (next() << 16) | (next() << 8) | next()) >>> 0;
      const takebacks = next();
      let fen = START_FEN;
      if (flags & 16) {
        const len = next();
        fen = Array.from({ length: len }, () => String.fromCharCode(next())).join("");
      }
      const count = (next() << 8) | next();
      const chess = new Chess(fen);
      const moves: string[] = [];
      for (let i = 0; i < count; i++) {
        const uci = legalUci(chess)[next()];
        if (!uci) throw new Error("That game code is damaged (a move doesn't fit the position)");
        moves.push(uci);
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      }
      const winnerBits = res & 3;
      games.push({
        fen,
        moves,
        playerColor: flags & 1 ? "b" : "w",
        level: (flags >> 1) & 7,
        result: { winner: winnerBits === 0 ? null : winnerBits === 1 ? "w" : "b", reason: REASONS[(res >> 2) & 7] ?? "checkmate" },
        date: new Date(minutes * 60000).toISOString(),
        takebacks,
      });
    }
  }
  return games;
}
