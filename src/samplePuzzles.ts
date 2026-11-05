// A few real puzzles from data/puzzles.db for running the UI in a plain browser (npm run dev).
// Generated: sqlite3 data/puzzles.db (see README).
import type { Puzzle } from "./api";

export const SAMPLE_PUZZLES: Puzzle[] = [
  { id: "Nr819", fen: "5rk1/p1b3pp/Q3ppb1/2P4P/6P1/1P6/P7/K1r2R2 w - - 0 31", moves: "f1c1 c7e5 c1c3 e5c3", rating: 641, themes: ["doubleBishopMate", "endgame", "master", "mate", "mateIn2", "short"] },
  { id: "rAJh8", fen: "r1bqk2r/pppn2bp/8/4pp1Q/2B5/2P1P2P/PP3PP1/RN2K2R b KQkq - 1 13", moves: "e8f8 h5f7", rating: 751, themes: ["mate", "mateIn1", "oneMove", "opening"] },
  { id: "1RQWo", fen: "8/4b3/6k1/5p2/3BnPp1/6Pp/7P/3R1K2 w - - 2 45", moves: "d1b1 e4d2 f1e2 d2b1", rating: 801, themes: ["crushing", "endgame", "fork", "master", "short"] },
  { id: "bPCyi", fen: "4r1k1/ppQ2pp1/3p2n1/3P2qp/1P1P4/P5PP/6BK/5R2 b - - 1 28", moves: "h5h4 c7f7 g8h7 f7e8", rating: 866, themes: ["crushing", "endgame", "fork", "short"] },
  { id: "6tybX", fen: "rn3r2/3bqN2/p1pNp1pk/1p1nPp2/3P4/1B6/PP1Q1PPP/2R3K1 b - - 1 25", moves: "h6g7 d2h6 g7g8 h6g6", rating: 868, themes: ["deflection", "master", "mate", "mateIn2", "middlegame", "short"] },
  { id: "85opA", fen: "r1bq1rk1/2p2ppn/p2b3p/1p1PN3/5Q2/2N5/PPP1B1PP/3RR1K1 b - - 2 18", moves: "f8e8 f4f7 g8h8 e5g6", rating: 898, themes: ["kingsideAttack", "mate", "mateIn2", "middlegame", "short"] },
  { id: "BjlMC", fen: "r1b2k2/pp3pb1/2p5/5pQ1/1qP5/1P6/5PBN/3R2K1 b - - 2 29", moves: "c8e6 d1d8 a8d8 g5d8", rating: 949, themes: ["mate", "mateIn2", "middlegame", "short"] },
  { id: "3loC9", fen: "3r3k/p1q4n/2p1B3/1pn2r2/5PQP/P3P3/1RP5/4K1R1 b - - 0 30", moves: "f5f6 g4g8 d8g8 g1g8", rating: 1015, themes: ["mate", "mateIn2", "middlegame", "operaMate", "sacrifice", "short"] },
  { id: "eJisc", fen: "7r/2Nn1p2/3k2b1/3pp1B1/1P4P1/5PK1/7r/1R2R3 w - - 4 35", moves: "b1c1 h8h3", rating: 1051, themes: ["blindSwineMate", "mate", "mateIn1", "middlegame", "oneMove"] },
  { id: "In8j4", fen: "8/3R4/2p1p1P1/1bB1kp2/8/4PK2/7P/6r1 b - - 2 41", moves: "g1g6 c5d4", rating: 1053, themes: ["endgame", "mate", "mateIn1", "morphysMate", "oneMove"] },
  { id: "ngFjX", fen: "r2q1r2/1b2kN2/p1n4Q/1pp2p2/4p3/P7/BPP1N1PP/R5K1 b - - 0 21", moves: "f8f7 h6e6 e7f8 e6f7", rating: 1153, themes: ["mate", "mateIn2", "middlegame", "short"] },
  { id: "w54DR", fen: "3r2k1/1p3pp1/p3bb1p/4n3/4P3/B4N1P/PPP2PP1/2K2B1R w - - 3 18", moves: "f3e5 f6g5 f2f4 g5f4 c1b1 d8d1", rating: 1340, themes: ["fork", "long", "mate", "mateIn3", "middlegame"] },
  { id: "9Au7Y", fen: "8/5p2/p3rk2/1pR4p/5P2/6K1/PP6/8 b - - 0 39", moves: "f6g6 f4f5 g6f6 f5e6", rating: 1432, themes: ["crushing", "endgame", "fork", "rookEndgame", "short"] },
  { id: "6r8gU", fen: "2kr1b1r/ppp2ppp/1B3n2/1N1p4/1nQ5/5P1P/PPP2P2/2KR1B1R b - - 0 14", moves: "d5c4 b5a7 c8b8 d1d8", rating: 1520, themes: ["deflection", "mate", "mateIn2", "middlegame", "queensideAttack", "short"] },
  { id: "TgppO", fen: "1r6/p3p2k/3pb1p1/q7/1rp1nP2/2N5/PPP1B3/KRQ3R1 w - - 0 26", moves: "c3e4 a5a2 a1a2 b4a4", rating: 1532, themes: ["attraction", "mate", "mateIn2", "middlegame", "sacrifice", "short"] },
  { id: "sVvmj", fen: "r7/pp3kp1/4p2p/8/3PQN2/7P/5qPK/8 b - - 1 30", moves: "a8d8 e4e6 f7f8 f4g6", rating: 1632, themes: ["endgame", "mate", "mateIn2", "short"] },
  { id: "qWjJ9", fen: "r4k2/5p2/P4p1p/2N5/1P1p4/7P/2r2PP1/R5K1 b - - 2 33", moves: "c2c4 c5d7 f8g7 d7b6 a8a6 a1a6", rating: 1852, themes: ["advantage", "endgame", "fork", "long"] },
  { id: "m6pN4", fen: "4k2r/4bppp/2pp1n2/1P2n3/r3P3/4B2P/BPP1QPP1/2K4R w k - 0 18", moves: "a2b3 a4a1 c1d2 f6e4", rating: 1916, themes: ["mate", "mateIn2", "middlegame", "queensideAttack", "short"] },
  { id: "kwRGd", fen: "2r3k1/4q1p1/1Q1pPr1p/1p1B1p2/2p2P2/P6P/1P3KP1/4R3 b - - 1 33", moves: "c8c5 b6d8 e7d8 e6e7 c5d5 e7d8q", rating: 2045, themes: ["advancedPawn", "attraction", "crushing", "discoveredAttack", "endgame", "kingsideAttack", "long", "promotion", "sacrifice"] },
  { id: "aDn3v", fen: "8/8/8/1pK2P2/k1p5/2P5/8/8 b - - 0 55", moves: "a4b3 f5f6 b5b4 f6f7 b4c3 f7f8q", rating: 2109, themes: ["advancedPawn", "crushing", "endgame", "long", "pawnEndgame", "promotion"] },
  { id: "yVLML", fen: "3q2rk/ppp4p/3nR3/3pN3/3PR1Q1/2P4P/PP4K1/8 w - - 1 35", moves: "g4g8 d8g8 e5g6 h7g6 e4h4 h8g7 e6e7 g7f6", rating: 2149, themes: ["advantage", "endgame", "fork", "hangingPiece", "veryLong"] },
  { id: "7KvSx", fen: "8/6pk/1Qp1q2p/p1Pp2r1/3P4/P3pP2/4bnPP/4RRK1 w - - 0 34", moves: "e1e2 g5g2 g1g2 e6g6", rating: 2247, themes: ["attraction", "endgame", "kingsideAttack", "mate", "mateIn2", "sacrifice", "short"] },
  { id: "LOEuy", fen: "r5k1/ppp2ppp/3b1n1r/8/2B5/1P2PQNq/PB3P2/R4RK1 w - - 0 18", moves: "f1d1 d6g3 f2g3 h3h2 g1f1 h2b2", rating: 2328, themes: ["advantage", "fork", "long", "master", "middlegame"] },
  { id: "86a4h", fen: "2r5/pbqn2p1/1p1bpkP1/3p3R/3P1r2/PP1B3Q/5P2/1KB4R b - - 2 29", moves: "c7c3 h3h4 f4h4 c1g5", rating: 2389, themes: ["mate", "mateIn2", "middlegame", "sacrifice", "short"] },
];
