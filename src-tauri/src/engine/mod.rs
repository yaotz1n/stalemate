// The offline bot: a small alpha-beta engine (see board.rs, eval.rs, search.rs).

mod board;
mod eval;
mod search;

#[cfg(test)]
use board::START_FEN;
use board::Board;
use search::{level_limits, Rng, Searcher};

/// Number of difficulty levels (1 = beginner .. LEVELS = strongest).
pub const LEVELS: u8 = 5;

/// The bot's move (UCI, e.g. "e2e4") after `moves` (UCI) are played from `fen`,
/// or None if the game is already over.
pub fn best_move(fen: &str, moves: &[String], level: u8) -> Result<Option<String>, String> {
    let mut board = Board::from_fen(fen)?;
    for uci in moves {
        let m = board.parse_uci(uci).ok_or_else(|| format!("illegal move {uci}"))?;
        board.make(m);
    }
    let mut searcher = Searcher::new();
    let mut rng = Rng::from_clock();
    let limits = level_limits(level.clamp(1, LEVELS));
    Ok(searcher.choose(&mut board, limits, &mut rng).map(|m| m.uci()))
}

/// How `mv` (UCI) compares with the best move after `moves` from `fen`:
/// (best score, `mv`'s score) in centipawns for the side to move, from a short
/// search of about `ms`. None if `mv` is illegal or the search ran out of time.
pub fn judge_move(fen: &str, moves: &[String], mv: &str, ms: u64) -> Result<Option<(i32, i32)>, String> {
    let mut board = Board::from_fen(fen)?;
    for uci in moves {
        let m = board.parse_uci(uci).ok_or_else(|| format!("illegal move {uci}"))?;
        board.make(m);
    }
    let Some(m) = board.parse_uci(mv) else { return Ok(None) };
    Ok(Searcher::new().judge(&mut board, m, std::time::Duration::from_millis(ms)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn mv(fen: &str, level: u8) -> String {
        best_move(fen, &[], level).unwrap().unwrap()
    }

    #[test]
    fn finds_mate_in_one_at_every_level() {
        // Back-rank mate: Re8#.
        let fen = "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1";
        for level in 1..=LEVELS {
            assert_eq!(mv(fen, level), "e1e8", "level {level}");
        }
    }

    #[test]
    fn takes_a_hanging_queen() {
        // Black's queen on h4 is attacked by the knight on f3.
        let fen = "rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        for level in 3..=LEVELS {
            assert_eq!(mv(fen, level), "f3h4", "level {level}");
        }
    }

    #[test]
    fn judges_moves_against_the_best() {
        // Taking the hanging queen is (close to) best; giving away the knight instead isn't.
        let fen = "rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        let (best, take) = judge_move(fen, &[], "f3h4", 300).unwrap().unwrap();
        assert_eq!(take, best, "f3h4 is the engine's own choice, so it scores exactly level");
        let (best, blunder) = judge_move(fen, &[], "f3g5", 300).unwrap().unwrap();
        assert!(blunder < best - 300, "f3g5 {blunder} vs best {best}");
        // A sound sacrifice: Qd8+ gives up the queen, but Rxd8 Rxd8 is mate.
        let fen = "r5k1/5ppp/8/8/3Q4/8/5PPP/3R2K1 w - - 0 1";
        let (best, sac) = judge_move(fen, &[], "d4d8", 400).unwrap().unwrap();
        assert!(sac >= best - 50 && sac > 1000, "Qd8+ {sac} vs best {best}");
    }

    #[test]
    fn finds_scholars_mate() {
        let fen = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
        assert_eq!(mv(fen, LEVELS), "h5f7");
    }

    #[test]
    fn finds_mate_in_two() {
        // King and rook vs king: White mates in two whatever Black replies.
        let fen = "k7/8/2K5/8/8/8/8/7R w - - 0 1";
        let first = mv(fen, LEVELS);
        let mut board = Board::from_fen(fen).unwrap();
        let m = board.parse_uci(&first).unwrap();
        board.make(m);
        for reply in board.legal_moves() {
            board.make(reply);
            let fen_now = board_fen_for_test(&board);
            let second = mv(&fen_now, LEVELS);
            let mut after = Board::from_fen(&fen_now).unwrap();
            let m2 = after.parse_uci(&second).unwrap();
            after.make(m2);
            assert!(after.in_check() && after.legal_moves().is_empty(), "{first} {} {second} isn't mate", reply.uci());
            board.unmake();
        }
    }

    /// Minimal FEN writer for tests (no castling or en passant needed here).
    fn board_fen_for_test(b: &Board) -> String {
        let mut s = String::new();
        for rank in (0..8).rev() {
            let mut empty = 0;
            for file in 0..8 {
                let p = b.sq[rank * 16 + file];
                if p == 0 {
                    empty += 1;
                    continue;
                }
                if empty > 0 {
                    s.push_str(&empty.to_string());
                    empty = 0;
                }
                let c = b" pnbrqk"[(p & 7) as usize] as char;
                s.push(if p & 8 == 0 { c.to_ascii_uppercase() } else { c });
            }
            if empty > 0 {
                s.push_str(&empty.to_string());
            }
            if rank > 0 {
                s.push('/');
            }
        }
        format!("{s} {} - - 0 1", if b.side == 0 { "w" } else { "b" })
    }

    #[test]
    fn no_moves_when_mated() {
        let fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"; // fool's mate
        assert_eq!(best_move(fen, &[], 3).unwrap(), None);
    }

    #[test]
    fn replays_moves_before_thinking() {
        let moves: Vec<String> = ["e2e4", "e7e5", "g1f3"].iter().map(|s| s.to_string()).collect();
        let reply = best_move(START_FEN, &moves, 2).unwrap().unwrap();
        // Black to move: the reply must start from a black piece's square.
        assert!(reply.as_bytes()[1] == b'7' || reply.as_bytes()[1] == b'8', "{reply}");
    }

    #[test]
    fn rejects_illegal_history() {
        assert!(best_move(START_FEN, &["e2e5".to_string()], 1).is_err());
    }

    #[test]
    fn strongest_level_respects_its_time_limit() {
        let start = Instant::now();
        mv("r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8", LEVELS);
        // 1.5 s to search plus a margin for slow CI machines.
        assert!(start.elapsed() < Duration::from_millis(2500), "took {:?}", start.elapsed());
    }

    #[test]
    fn weak_levels_vary_their_play() {
        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        let picks: std::collections::HashSet<String> = (0..12).map(|_| mv(fen, 1)).collect();
        assert!(picks.len() > 1, "level 1 always played {picks:?}");
    }

    /// Plays the levels against each other (slow; run with --ignored --nocapture).
    #[test]
    #[ignore]
    fn level_ladder() {
        let mut rng = Rng::from_clock();
        for (a, b) in [(2, 1), (3, 2), (4, 3), (5, 4)] {
            let mut score = 0.0;
            let games = 10;
            for g in 0..games {
                // Alternate colors; strong side is `a`.
                let a_white = g % 2 == 0;
                let mut board = Board::from_fen(START_FEN).unwrap();
                let mut result = 0.5;
                for _ in 0..200 {
                    let level = if (board.side == 0) == a_white { a } else { b };
                    let mut s = Searcher::new();
                    match s.choose(&mut board, level_limits(level), &mut rng) {
                        None => {
                            if board.in_check() {
                                let a_to_move = (board.side == 0) == a_white;
                                result = if a_to_move { 0.0 } else { 1.0 };
                            }
                            break;
                        }
                        Some(m) => {
                            board.make(m);
                        }
                    }
                    if board.halfmove >= 100 || board.is_repetition() {
                        break;
                    }
                }
                score += result;
            }
            println!("level {a} vs level {b}: {score}/{games}");
        }
    }
}
