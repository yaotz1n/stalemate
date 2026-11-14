// Search: iterative deepening alpha-beta (principal variation search) with a
// quiescence search, transposition table, null-move pruning, late-move
// reductions, killer moves and history ordering. Weaker levels search shallower
// and then pick among the near-best root moves at random, weighted toward the
// better ones, so their mistakes look like plausible human ones.

use std::time::{Duration, Instant};

use super::board::*;
use super::eval::{evaluate, ORDER_VALUE};

pub const INF: i32 = 32_000;
pub const MATE: i32 = 30_000;
const MAX_PLY: usize = 96;
/// 2^17 entries × 24 bytes ≈ 3 MB.
const TT_BITS: u32 = 17;

const EXACT: u8 = 0;
const LOWER: u8 = 1;
const UPPER: u8 = 2;

#[derive(Clone, Copy, Default)]
struct TtEntry {
    key: u64,
    mv: u32,
    score: i32,
    depth: i8,
    flag: u8,
}

/// How a level plays.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_depth: i32,
    pub time: Duration,
    /// Root moves within this many centipawns of the best can be picked.
    pub margin: i32,
    /// Softness of that pick: higher = weaker moves chosen more often.
    pub temperature: f64,
}

/// Difficulty levels 1 (beginner) to 5 (expert).
pub fn level_limits(level: u8) -> Limits {
    let ms = Duration::from_millis;
    match level {
        1 => Limits { max_depth: 1, time: ms(200), margin: 350, temperature: 120.0 },
        2 => Limits { max_depth: 2, time: ms(300), margin: 180, temperature: 60.0 },
        3 => Limits { max_depth: 3, time: ms(400), margin: 90, temperature: 30.0 },
        4 => Limits { max_depth: 5, time: ms(600), margin: 30, temperature: 10.0 },
        _ => Limits { max_depth: 64, time: ms(1500), margin: 0, temperature: 1.0 },
    }
}

/// Small xorshift RNG; seeded from the clock so games differ.
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        // splitmix64 the seed: clock seeds differ only in low bits, which xorshift mixes poorly.
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Rng((z ^ (z >> 31)) | 1)
    }
    pub fn from_clock() -> Rng {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x1234_5678);
        Rng::new(nanos ^ 0x2545_F491_4F6C_DD1D)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    pub fn float(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub struct Searcher {
    tt: Vec<TtEntry>,
    killers: [[Move; 2]; MAX_PLY],
    history: Box<[[i32; 128]; 16]>,
    pub nodes: u64,
    deadline: Instant,
    stop: bool,
}

impl Default for Searcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Searcher {
    pub fn new() -> Searcher {
        Searcher {
            tt: vec![TtEntry::default(); 1 << TT_BITS],
            killers: [[Move::NULL; 2]; MAX_PLY],
            history: Box::new([[0; 128]; 16]),
            nodes: 0,
            deadline: Instant::now(),
            stop: false,
        }
    }

    /// Chooses a move for the side to move, or None if there are no legal moves.
    pub fn choose(&mut self, board: &mut Board, limits: Limits, rng: &mut Rng) -> Option<Move> {
        let start = Instant::now();
        self.deadline = start + limits.time;
        self.stop = false;
        self.nodes = 0;
        self.killers = [[Move::NULL; 2]; MAX_PLY];
        for row in self.history.iter_mut() {
            row.fill(0);
        }

        let mut root = board.legal_moves();
        if root.len() <= 1 {
            return root.first().copied();
        }

        // Iterative deepening: each finished depth leaves its best move first.
        let mut best = root[0];
        let mut completed = 0;
        for depth in 1..=limits.max_depth {
            let (mv, _score) = self.search_root(board, &mut root, depth);
            if self.stop {
                break;
            }
            best = mv;
            completed = depth;
            // A deeper iteration takes several times longer; don't start one we can't finish.
            if start.elapsed() * 3 > limits.time {
                break;
            }
        }

        // Early opening: a little variety even at full strength.
        let (margin, temperature) = if limits.margin == 0 && board.fullmove <= 4 {
            (15, 8.0)
        } else {
            (limits.margin, limits.temperature)
        };
        if margin == 0 || completed == 0 {
            return Some(best);
        }

        // Score every root move with a full window, then pick near the top.
        self.deadline = Instant::now() + limits.time;
        let mut scored = Vec::with_capacity(root.len());
        for &m in &root {
            board.make(m);
            let s = -self.negamax(board, completed - 1, -INF, INF, 1, true);
            board.unmake();
            if self.stop {
                return Some(best);
            }
            scored.push((m, s));
        }
        let top = scored.iter().map(|&(_, s)| s).max().unwrap();
        let candidates: Vec<(Move, f64)> = scored
            .iter()
            .filter(|&&(_, s)| s >= top - margin && !(top >= MATE - 200 && s < top))
            .map(|&(m, s)| (m, (-((top - s) as f64) / temperature).exp()))
            .collect();
        let total: f64 = candidates.iter().map(|c| c.1).sum();
        let mut roll = rng.float() * total;
        for &(m, w) in &candidates {
            roll -= w;
            if roll <= 0.0 {
                return Some(m);
            }
        }
        Some(candidates.last().map(|c| c.0).unwrap_or(best))
    }

    /// Scores `mv` against the best move, both from the side to move's view (centipawns),
    /// searching for about `time`. None if `mv` isn't legal or nothing finished in time.
    pub fn judge(&mut self, board: &mut Board, mv: Move, time: Duration) -> Option<(i32, i32)> {
        let start = Instant::now();
        self.deadline = start + time;
        self.stop = false;
        self.nodes = 0;
        self.killers = [[Move::NULL; 2]; MAX_PLY];
        for row in self.history.iter_mut() {
            row.fill(0);
        }
        let mut root = board.legal_moves();
        if !root.contains(&mv) {
            return None;
        }
        let mut best_move = None;
        let mut completed = 0;
        for depth in 1..=64 {
            let (m, _) = self.search_root(board, &mut root, depth);
            if self.stop {
                break;
            }
            best_move = Some(m);
            completed = depth;
            if start.elapsed() * 3 > time {
                break;
            }
        }
        let best_move = best_move?;
        // Score the best move and the played one the same way (full window, same
        // depth), so the engine's own choice always comes out exactly level with itself.
        self.deadline = Instant::now() + time;
        self.stop = false;
        let mut full = |s: &mut Self, m: Move| {
            board.make(m);
            let v = -s.negamax(board, completed - 1, -INF, INF, 1, true);
            board.unmake();
            v
        };
        let best = full(self, best_move);
        let score = if mv == best_move { best } else { full(self, mv) };
        if self.stop {
            return None;
        }
        Some((best.max(score), score))
    }

    /// One iteration at the root. Reorders `root` so the best move comes first.
    fn search_root(&mut self, board: &mut Board, root: &mut [Move], depth: i32) -> (Move, i32) {
        let mut alpha = -INF;
        let beta = INF;
        let mut best_idx = 0;
        for i in 0..root.len() {
            let m = root[i];
            board.make(m);
            let score = if i == 0 {
                -self.negamax(board, depth - 1, -beta, -alpha, 1, true)
            } else {
                let s = -self.negamax(board, depth - 1, -alpha - 1, -alpha, 1, true);
                if s > alpha && !self.stop { -self.negamax(board, depth - 1, -beta, -alpha, 1, true) } else { s }
            };
            board.unmake();
            if self.stop {
                // Unfinished iteration: the caller keeps the previous depth's move.
                return (root[0], alpha);
            }
            if score > alpha {
                alpha = score;
                best_idx = i;
            }
        }
        root[..=best_idx].rotate_right(1);
        self.store(board.hash, depth, alpha, EXACT, root[0], 0);
        (root[0], alpha)
    }

    fn check_time(&mut self) {
        if self.nodes & 1023 == 0 && Instant::now() >= self.deadline {
            self.stop = true;
        }
    }

    fn negamax(&mut self, board: &mut Board, depth: i32, mut alpha: i32, beta: i32, ply: usize, allow_null: bool) -> i32 {
        if board.halfmove >= 100 || board.is_repetition() {
            return 0;
        }
        self.nodes += 1;
        self.check_time();
        if self.stop {
            return 0;
        }
        if ply >= MAX_PLY - 1 {
            return evaluate(board);
        }

        let in_check = board.in_check();
        let depth = if in_check { depth + 1 } else { depth };
        if depth <= 0 {
            return self.quiesce(board, alpha, beta, ply);
        }

        let pv = beta - alpha > 1;
        let mut tt_move = Move::NULL;
        let entry = self.tt[(board.hash & ((1 << TT_BITS) - 1)) as usize];
        if entry.key == board.hash {
            tt_move = Move::unpack(entry.mv);
            if !pv && entry.depth as i32 >= depth {
                let s = from_tt(entry.score, ply);
                match entry.flag {
                    EXACT => return s,
                    LOWER if s >= beta => return s,
                    UPPER if s <= alpha => return s,
                    _ => {}
                }
            }
        }

        // Null move: if passing still beats beta, the position is good enough.
        if !pv && !in_check && allow_null && depth >= 3 && board.has_pieces(board.side) && evaluate(board) >= beta {
            let r = 2 + depth / 6;
            board.make_null();
            let s = -self.negamax(board, depth - 1 - r, -beta, -beta + 1, ply + 1, false);
            board.unmake_null();
            if self.stop {
                return 0;
            }
            if s >= beta {
                return beta;
            }
        }

        let mut moves = Vec::with_capacity(48);
        board.gen_moves(&mut moves, false);
        let mut scores: Vec<i32> = moves.iter().map(|&m| self.order_score(board, m, tt_move, ply)).collect();

        let original_alpha = alpha;
        let mut best = -INF;
        let mut best_move = Move::NULL;
        let mut legal = 0;
        for i in 0..moves.len() {
            // Selection sort: cheap, and most nodes cut off after a move or two.
            let mut pick = i;
            for j in i + 1..moves.len() {
                if scores[j] > scores[pick] {
                    pick = j;
                }
            }
            moves.swap(i, pick);
            scores.swap(i, pick);
            let m = moves[i];
            if !board.make(m) {
                continue;
            }
            legal += 1;
            let gives_check = board.in_check();
            let quiet = m.is_quiet();
            let mut score;
            if legal == 1 {
                score = -self.negamax(board, depth - 1, -beta, -alpha, ply + 1, true);
            } else {
                let mut r = 0;
                if depth >= 3 && quiet && !in_check && !gives_check && legal > 3 && !self.is_killer(m, ply) {
                    r = if legal > 8 { 2 } else { 1 };
                }
                score = -self.negamax(board, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
                if score > alpha && (r > 0 || score < beta) && !self.stop {
                    score = -self.negamax(board, depth - 1, -beta, -alpha, ply + 1, true);
                }
            }
            board.unmake();
            if self.stop {
                return 0;
            }
            if score > best {
                best = score;
                best_move = m;
                if score > alpha {
                    alpha = score;
                    if score >= beta {
                        if quiet {
                            self.add_killer(m, ply);
                            let piece = board.sq[m.from as usize] as usize;
                            self.history[piece][m.to as usize] += depth * depth;
                        }
                        break;
                    }
                }
            }
        }
        if legal == 0 {
            return if in_check { -MATE + ply as i32 } else { 0 };
        }
        let flag = if best >= beta {
            LOWER
        } else if best > original_alpha {
            EXACT
        } else {
            UPPER
        };
        self.store(board.hash, depth, best, flag, best_move, ply);
        best
    }

    fn quiesce(&mut self, board: &mut Board, mut alpha: i32, beta: i32, ply: usize) -> i32 {
        self.nodes += 1;
        self.check_time();
        if self.stop {
            return 0;
        }
        let stand = evaluate(board);
        if stand >= beta || ply >= MAX_PLY - 1 {
            return stand;
        }
        alpha = alpha.max(stand);
        let mut moves = Vec::with_capacity(16);
        board.gen_moves(&mut moves, true);
        let mut scores: Vec<i32> = moves.iter().map(|&m| mvv_lva(board, m)).collect();
        for i in 0..moves.len() {
            let mut pick = i;
            for j in i + 1..moves.len() {
                if scores[j] > scores[pick] {
                    pick = j;
                }
            }
            moves.swap(i, pick);
            scores.swap(i, pick);
            if !board.make(moves[i]) {
                continue;
            }
            let score = -self.quiesce(board, -beta, -alpha, ply + 1);
            board.unmake();
            if self.stop {
                return 0;
            }
            if score >= beta {
                return score;
            }
            alpha = alpha.max(score);
        }
        alpha
    }

    fn order_score(&self, board: &Board, m: Move, tt_move: Move, ply: usize) -> i32 {
        if m == tt_move {
            return 1_000_000;
        }
        if m.is_capture() || m.promo != 0 {
            return 100_000 + mvv_lva(board, m);
        }
        if self.killers[ply][0] == m {
            return 90_000;
        }
        if self.killers[ply][1] == m {
            return 80_000;
        }
        self.history[board.sq[m.from as usize] as usize][m.to as usize].min(70_000)
    }

    fn is_killer(&self, m: Move, ply: usize) -> bool {
        self.killers[ply][0] == m || self.killers[ply][1] == m
    }

    fn add_killer(&mut self, m: Move, ply: usize) {
        if self.killers[ply][0] != m {
            self.killers[ply][1] = self.killers[ply][0];
            self.killers[ply][0] = m;
        }
    }

    fn store(&mut self, key: u64, depth: i32, score: i32, flag: u8, mv: Move, ply: usize) {
        let slot = &mut self.tt[(key & ((1 << TT_BITS) - 1)) as usize];
        // Replace unless a deeper result for the same position is already there.
        if slot.key != key || depth as i8 >= slot.depth {
            *slot = TtEntry { key, mv: mv.pack(), score: to_tt(score, ply), depth: depth as i8, flag };
        }
    }
}

/// Most valuable victim, least valuable attacker.
fn mvv_lva(board: &Board, m: Move) -> i32 {
    let victim = if m.flags & EN_PASSANT != 0 { PAWN } else { kind_of(board.sq[m.to as usize]) };
    let attacker = kind_of(board.sq[m.from as usize]);
    let promo = if m.promo != 0 { ORDER_VALUE[m.promo as usize] } else { 0 };
    ORDER_VALUE[victim as usize] * 10 - ORDER_VALUE[attacker as usize] / 10 + promo
}

// Mate scores are stored relative to the node, not the root.
fn to_tt(score: i32, ply: usize) -> i32 {
    if score >= MATE - 1000 {
        score + ply as i32
    } else if score <= -MATE + 1000 {
        score - ply as i32
    } else {
        score
    }
}
fn from_tt(score: i32, ply: usize) -> i32 {
    if score >= MATE - 1000 {
        score - ply as i32
    } else if score <= -MATE + 1000 {
        score + ply as i32
    } else {
        score
    }
}
