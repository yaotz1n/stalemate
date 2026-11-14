// Board representation for the bot: a 0x88 mailbox (square = rank * 16 + file,
// rank 0 = rank 1), pseudo-legal move generation with a legality check on make,
// and Zobrist hashing for the transposition table and repetition detection.

use std::sync::OnceLock;

pub const WHITE: usize = 0;
pub const BLACK: usize = 1;

pub const PAWN: u8 = 1;
pub const KNIGHT: u8 = 2;
pub const BISHOP: u8 = 3;
pub const ROOK: u8 = 4;
pub const QUEEN: u8 = 5;
pub const KING: u8 = 6;
/// Set on black pieces: piece = kind | (color << 3).
pub const BLACK_BIT: u8 = 8;
pub const EMPTY: u8 = 0;

pub const NO_SQ: u8 = 0x7f;

const WK: u8 = 1;
const WQ: u8 = 2;
const BK: u8 = 4;
const BQ: u8 = 8;

pub const CAPTURE: u8 = 1;
pub const EN_PASSANT: u8 = 2;
pub const CASTLE: u8 = 4;
pub const DOUBLE_PUSH: u8 = 8;

pub const KNIGHT_DIRS: [i32; 8] = [33, 31, 18, 14, -33, -31, -18, -14];
pub const KING_DIRS: [i32; 8] = [1, -1, 16, -16, 15, 17, -15, -17];
pub const BISHOP_DIRS: [i32; 4] = [15, 17, -15, -17];
pub const ROOK_DIRS: [i32; 4] = [1, -1, 16, -16];

#[inline]
pub fn color_of(piece: u8) -> usize {
    (piece >> 3) as usize
}
#[inline]
pub fn kind_of(piece: u8) -> u8 {
    piece & 7
}
#[inline]
pub fn make_piece(kind: u8, color: usize) -> u8 {
    kind | ((color as u8) << 3)
}
#[inline]
pub fn on_board(sq: i32) -> bool {
    sq & 0x88 == 0
}
#[inline]
pub fn file_of(sq: u8) -> u8 {
    sq & 7
}
#[inline]
pub fn rank_of(sq: u8) -> u8 {
    sq >> 4
}

pub fn square_name(sq: u8) -> String {
    format!("{}{}", (b'a' + file_of(sq)) as char, rank_of(sq) + 1)
}

pub fn parse_square(s: &str) -> Option<u8> {
    let b = s.as_bytes();
    if b.len() != 2 || !(b'a'..=b'h').contains(&b[0]) || !(b'1'..=b'8').contains(&b[1]) {
        return None;
    }
    Some((b[1] - b'1') * 16 + (b[0] - b'a'))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Move {
    pub from: u8,
    pub to: u8,
    /// Promotion piece kind (KNIGHT..QUEEN), 0 if none.
    pub promo: u8,
    pub flags: u8,
}

impl Move {
    pub const NULL: Move = Move { from: 0, to: 0, promo: 0, flags: 0 };

    #[inline]
    pub fn is_capture(&self) -> bool {
        self.flags & CAPTURE != 0
    }
    #[inline]
    pub fn is_quiet(&self) -> bool {
        self.flags & CAPTURE == 0 && self.promo == 0
    }

    pub fn pack(&self) -> u32 {
        self.from as u32 | (self.to as u32) << 8 | (self.promo as u32) << 16 | (self.flags as u32) << 24
    }
    pub fn unpack(v: u32) -> Move {
        Move { from: v as u8, to: (v >> 8) as u8, promo: (v >> 16) as u8, flags: (v >> 24) as u8 }
    }

    pub fn uci(&self) -> String {
        let mut s = square_name(self.from) + &square_name(self.to);
        if self.promo != 0 {
            s.push(match self.promo {
                KNIGHT => 'n',
                BISHOP => 'b',
                ROOK => 'r',
                _ => 'q',
            });
        }
        s
    }
}

struct Zobrist {
    pieces: [[u64; 128]; 16],
    castling: [u64; 16],
    ep_file: [u64; 8],
    side: u64,
}

fn zobrist() -> &'static Zobrist {
    static Z: OnceLock<Zobrist> = OnceLock::new();
    Z.get_or_init(|| {
        // splitmix64 with a fixed seed: the same keys every run.
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        let mut z = Zobrist { pieces: [[0; 128]; 16], castling: [0; 16], ep_file: [0; 8], side: 0 };
        for p in z.pieces.iter_mut() {
            for k in p.iter_mut() {
                *k = next();
            }
        }
        for k in z.castling.iter_mut() {
            *k = next();
        }
        for k in z.ep_file.iter_mut() {
            *k = next();
        }
        z.side = next();
        z
    })
}

/// Castling rights kept after a move touches a square (king or rook moved or captured).
fn castle_mask(sq: u8) -> u8 {
    match sq {
        0x04 => !(WK | WQ),
        0x07 => !WK,
        0x00 => !WQ,
        0x74 => !(BK | BQ),
        0x77 => !BK,
        0x70 => !BQ,
        _ => 0xff,
    }
}

#[derive(Clone, Copy)]
struct Undo {
    mv: Move,
    captured: u8,
    castling: u8,
    ep: u8,
    halfmove: u32,
    hash: u64,
}

#[derive(Clone)]
pub struct Board {
    pub sq: [u8; 128],
    pub side: usize,
    pub castling: u8,
    pub ep: u8,
    pub halfmove: u32,
    pub fullmove: u32,
    pub king: [u8; 2],
    pub hash: u64,
    /// Hashes of earlier positions (before each move), for repetition checks.
    history: Vec<u64>,
    undo: Vec<Undo>,
}

#[cfg(test)]
pub const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

impl Board {
    pub fn from_fen(fen: &str) -> Result<Board, String> {
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() < 4 {
            return Err(format!("bad FEN: {fen}"));
        }
        let mut b = Board {
            sq: [EMPTY; 128],
            side: WHITE,
            castling: 0,
            ep: NO_SQ,
            halfmove: 0,
            fullmove: 1,
            king: [NO_SQ; 2],
            hash: 0,
            history: Vec::with_capacity(256),
            undo: Vec::with_capacity(256),
        };
        let mut rank: i32 = 7;
        let mut file: i32 = 0;
        for c in parts[0].chars() {
            match c {
                '/' => {
                    rank -= 1;
                    file = 0;
                }
                '1'..='8' => file += c as i32 - '0' as i32,
                _ => {
                    let color = if c.is_ascii_uppercase() { WHITE } else { BLACK };
                    let kind = match c.to_ascii_lowercase() {
                        'p' => PAWN,
                        'n' => KNIGHT,
                        'b' => BISHOP,
                        'r' => ROOK,
                        'q' => QUEEN,
                        'k' => KING,
                        _ => return Err(format!("bad FEN piece '{c}'")),
                    };
                    if !(0..8).contains(&rank) || !(0..8).contains(&file) {
                        return Err(format!("bad FEN board: {}", parts[0]));
                    }
                    let s = (rank * 16 + file) as u8;
                    b.sq[s as usize] = make_piece(kind, color);
                    if kind == KING {
                        b.king[color] = s;
                    }
                    file += 1;
                }
            }
        }
        if b.king[WHITE] == NO_SQ || b.king[BLACK] == NO_SQ {
            return Err("FEN needs both kings".into());
        }
        b.side = if parts[1] == "b" { BLACK } else { WHITE };
        for c in parts[2].chars() {
            b.castling |= match c {
                'K' => WK,
                'Q' => WQ,
                'k' => BK,
                'q' => BQ,
                _ => 0,
            };
        }
        b.ep = if parts[3] == "-" { NO_SQ } else { parse_square(parts[3]).unwrap_or(NO_SQ) };
        b.halfmove = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        b.fullmove = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);
        b.hash = b.compute_hash();
        Ok(b)
    }

    fn compute_hash(&self) -> u64 {
        let z = zobrist();
        let mut h = 0;
        for s in 0..128 {
            if on_board(s) && self.sq[s as usize] != EMPTY {
                h ^= z.pieces[self.sq[s as usize] as usize][s as usize];
            }
        }
        h ^= z.castling[self.castling as usize];
        if self.ep != NO_SQ {
            h ^= z.ep_file[file_of(self.ep) as usize];
        }
        if self.side == BLACK {
            h ^= z.side;
        }
        h
    }

    /// Is `sq` attacked by any piece of color `by`?
    pub fn attacked(&self, sq: u8, by: usize) -> bool {
        let s = sq as i32;
        let piece = |t: i32| self.sq[t as usize];
        // Pawns: a white pawn on t attacks t+15 and t+17.
        let (p1, p2, pawn) = if by == WHITE { (s - 15, s - 17, PAWN) } else { (s + 15, s + 17, PAWN | BLACK_BIT) };
        if (on_board(p1) && piece(p1) == pawn) || (on_board(p2) && piece(p2) == pawn) {
            return true;
        }
        let knight = make_piece(KNIGHT, by);
        for d in KNIGHT_DIRS {
            let t = s + d;
            if on_board(t) && piece(t) == knight {
                return true;
            }
        }
        let king = make_piece(KING, by);
        for d in KING_DIRS {
            let t = s + d;
            if on_board(t) && piece(t) == king {
                return true;
            }
        }
        let (bishop, rook, queen) = (make_piece(BISHOP, by), make_piece(ROOK, by), make_piece(QUEEN, by));
        for d in BISHOP_DIRS {
            let mut t = s + d;
            while on_board(t) {
                let p = piece(t);
                if p != EMPTY {
                    if p == bishop || p == queen {
                        return true;
                    }
                    break;
                }
                t += d;
            }
        }
        for d in ROOK_DIRS {
            let mut t = s + d;
            while on_board(t) {
                let p = piece(t);
                if p != EMPTY {
                    if p == rook || p == queen {
                        return true;
                    }
                    break;
                }
                t += d;
            }
        }
        false
    }

    #[inline]
    pub fn in_check(&self) -> bool {
        self.attacked(self.king[self.side], self.side ^ 1)
    }

    /// Pseudo-legal moves (may leave the king in check; `make` rejects those).
    /// `captures_only` gives captures and queen promotions, for quiescence search.
    pub fn gen_moves(&self, out: &mut Vec<Move>, captures_only: bool) {
        out.clear();
        let us = self.side;
        let them = us ^ 1;
        let push = |out: &mut Vec<Move>, from: i32, to: i32, flags: u8| {
            out.push(Move { from: from as u8, to: to as u8, promo: 0, flags });
        };
        for s in 0..128i32 {
            if !on_board(s) {
                continue;
            }
            let p = self.sq[s as usize];
            if p == EMPTY || color_of(p) != us {
                continue;
            }
            match kind_of(p) {
                PAWN => {
                    let dir = if us == WHITE { 16 } else { -16 };
                    let start_rank = if us == WHITE { 1 } else { 6 };
                    let promo_rank = if us == WHITE { 7 } else { 0 };
                    let to = s + dir;
                    let promoting = on_board(to) && rank_of(to as u8) == promo_rank;
                    let add_promos = |out: &mut Vec<Move>, to: i32, flags: u8| {
                        if captures_only {
                            out.push(Move { from: s as u8, to: to as u8, promo: QUEEN, flags });
                        } else {
                            for promo in [QUEEN, KNIGHT, ROOK, BISHOP] {
                                out.push(Move { from: s as u8, to: to as u8, promo, flags });
                            }
                        }
                    };
                    if on_board(to) && self.sq[to as usize] == EMPTY {
                        if promoting {
                            add_promos(out, to, 0);
                        } else if !captures_only {
                            push(out, s, to, 0);
                            let to2 = to + dir;
                            if rank_of(s as u8) == start_rank && self.sq[to2 as usize] == EMPTY {
                                push(out, s, to2, DOUBLE_PUSH);
                            }
                        }
                    }
                    for side_step in [-1, 1] {
                        let t = s + dir + side_step;
                        if !on_board(t) {
                            continue;
                        }
                        let target = self.sq[t as usize];
                        if target != EMPTY && color_of(target) == them {
                            if promoting {
                                add_promos(out, t, CAPTURE);
                            } else {
                                push(out, s, t, CAPTURE);
                            }
                        } else if t as u8 == self.ep {
                            push(out, s, t, CAPTURE | EN_PASSANT);
                        }
                    }
                }
                KNIGHT | KING => {
                    let dirs = if kind_of(p) == KNIGHT { &KNIGHT_DIRS } else { &KING_DIRS };
                    for &d in dirs {
                        let t = s + d;
                        if !on_board(t) {
                            continue;
                        }
                        let target = self.sq[t as usize];
                        if target == EMPTY {
                            if !captures_only {
                                push(out, s, t, 0);
                            }
                        } else if color_of(target) == them {
                            push(out, s, t, CAPTURE);
                        }
                    }
                }
                kind => {
                    let dirs: &[i32] = match kind {
                        BISHOP => &BISHOP_DIRS,
                        ROOK => &ROOK_DIRS,
                        _ => &KING_DIRS, // queen
                    };
                    for &d in dirs {
                        let mut t = s + d;
                        while on_board(t) {
                            let target = self.sq[t as usize];
                            if target == EMPTY {
                                if !captures_only {
                                    push(out, s, t, 0);
                                }
                            } else {
                                if color_of(target) == them {
                                    push(out, s, t, CAPTURE);
                                }
                                break;
                            }
                            t += d;
                        }
                    }
                }
            }
        }
        if !captures_only {
            self.gen_castles(out);
        }
    }

    fn gen_castles(&self, out: &mut Vec<Move>) {
        let us = self.side;
        let them = us ^ 1;
        let (e, k_right, q_right) = if us == WHITE { (0x04u8, WK, WQ) } else { (0x74u8, BK, BQ) };
        if self.king[us] != e || self.castling & (k_right | q_right) == 0 || self.attacked(e, them) {
            return;
        }
        let empty = |s: u8| self.sq[s as usize] == EMPTY;
        let rook = make_piece(ROOK, us);
        if self.castling & k_right != 0
            && self.sq[(e + 3) as usize] == rook
            && empty(e + 1)
            && empty(e + 2)
            && !self.attacked(e + 1, them)
            && !self.attacked(e + 2, them)
        {
            out.push(Move { from: e, to: e + 2, promo: 0, flags: CASTLE });
        }
        if self.castling & q_right != 0
            && self.sq[(e - 4) as usize] == rook
            && empty(e - 1)
            && empty(e - 2)
            && empty(e - 3)
            && !self.attacked(e - 1, them)
            && !self.attacked(e - 2, them)
        {
            out.push(Move { from: e, to: e - 2, promo: 0, flags: CASTLE });
        }
    }

    /// Plays `m`. Returns false (and leaves the board unchanged) if it would leave
    /// the mover's king in check.
    pub fn make(&mut self, m: Move) -> bool {
        let z = zobrist();
        let us = self.side;
        let from = m.from as usize;
        let to = m.to as usize;
        let piece = self.sq[from];
        let cap_sq = if m.flags & EN_PASSANT != 0 {
            if us == WHITE { to - 16 } else { to + 16 }
        } else {
            to
        };
        let captured = if m.flags & CAPTURE != 0 { self.sq[cap_sq] } else { EMPTY };

        self.undo.push(Undo { mv: m, captured, castling: self.castling, ep: self.ep, halfmove: self.halfmove, hash: self.hash });
        self.history.push(self.hash);

        let mut h = self.hash;
        h ^= z.pieces[piece as usize][from];
        if captured != EMPTY {
            h ^= z.pieces[captured as usize][cap_sq];
            self.sq[cap_sq] = EMPTY;
        }
        let placed = if m.promo != 0 { make_piece(m.promo, us) } else { piece };
        self.sq[from] = EMPTY;
        self.sq[to] = placed;
        h ^= z.pieces[placed as usize][to];

        if m.flags & CASTLE != 0 {
            let (rook_from, rook_to) = if to > from { (to + 1, to - 1) } else { (to - 2, to + 1) };
            let rook = self.sq[rook_from];
            self.sq[rook_from] = EMPTY;
            self.sq[rook_to] = rook;
            h ^= z.pieces[rook as usize][rook_from] ^ z.pieces[rook as usize][rook_to];
        }
        if kind_of(piece) == KING {
            self.king[us] = m.to;
        }

        h ^= z.castling[self.castling as usize];
        self.castling &= castle_mask(m.from) & castle_mask(m.to);
        h ^= z.castling[self.castling as usize];

        if self.ep != NO_SQ {
            h ^= z.ep_file[file_of(self.ep) as usize];
        }
        self.ep = NO_SQ;
        if m.flags & DOUBLE_PUSH != 0 {
            self.ep = if us == WHITE { m.from + 16 } else { m.from - 16 };
            h ^= z.ep_file[file_of(self.ep) as usize];
        }

        self.halfmove = if kind_of(piece) == PAWN || captured != EMPTY { 0 } else { self.halfmove + 1 };
        if us == BLACK {
            self.fullmove += 1;
        }
        self.side ^= 1;
        h ^= z.side;
        self.hash = h;

        if self.attacked(self.king[us], us ^ 1) {
            self.unmake();
            return false;
        }
        true
    }

    pub fn unmake(&mut self) {
        let u = self.undo.pop().expect("unmake without make");
        self.history.pop();
        self.side ^= 1;
        let us = self.side;
        if us == BLACK {
            self.fullmove -= 1;
        }
        let m = u.mv;
        let from = m.from as usize;
        let to = m.to as usize;
        let moved = if m.promo != 0 { make_piece(PAWN, us) } else { self.sq[to] };
        self.sq[from] = moved;
        self.sq[to] = EMPTY;
        if u.captured != EMPTY {
            let cap_sq = if m.flags & EN_PASSANT != 0 {
                if us == WHITE { to - 16 } else { to + 16 }
            } else {
                to
            };
            self.sq[cap_sq] = u.captured;
        }
        if m.flags & CASTLE != 0 {
            let (rook_from, rook_to) = if to > from { (to + 1, to - 1) } else { (to - 2, to + 1) };
            self.sq[rook_from] = self.sq[rook_to];
            self.sq[rook_to] = EMPTY;
        }
        if kind_of(moved) == KING {
            self.king[us] = m.from;
        }
        self.castling = u.castling;
        self.ep = u.ep;
        self.halfmove = u.halfmove;
        self.hash = u.hash;
    }

    /// Passes the move (for null-move pruning).
    pub fn make_null(&mut self) {
        let z = zobrist();
        self.undo.push(Undo { mv: Move::NULL, captured: EMPTY, castling: self.castling, ep: self.ep, halfmove: self.halfmove, hash: self.hash });
        self.history.push(self.hash);
        if self.ep != NO_SQ {
            self.hash ^= z.ep_file[file_of(self.ep) as usize];
            self.ep = NO_SQ;
        }
        // Positions before a null move can't repeat after it.
        self.halfmove = 0;
        self.side ^= 1;
        self.hash ^= z.side;
    }

    pub fn unmake_null(&mut self) {
        let u = self.undo.pop().expect("unmake_null without make_null");
        self.history.pop();
        self.side ^= 1;
        self.ep = u.ep;
        self.halfmove = u.halfmove;
        self.hash = u.hash;
    }

    /// The current position occurred before (same side to move) since the last
    /// capture or pawn move. The search treats a single repetition as a draw.
    pub fn is_repetition(&self) -> bool {
        let n = self.history.len() as i64;
        let limit = (n - self.halfmove as i64).max(0);
        let mut i = n - 2;
        while i >= limit {
            if self.history[i as usize] == self.hash {
                return true;
            }
            i -= 2;
        }
        false
    }

    /// Side `color` has a piece other than pawns and the king (null-move safety).
    pub fn has_pieces(&self, color: usize) -> bool {
        (0..128).any(|s| {
            let p = self.sq[s];
            on_board(s as i32) && p != EMPTY && color_of(p) == color && !matches!(kind_of(p), PAWN | KING)
        })
    }

    pub fn legal_moves(&mut self) -> Vec<Move> {
        let mut pseudo = Vec::with_capacity(64);
        self.gen_moves(&mut pseudo, false);
        pseudo.into_iter().filter(|&m| {
            let ok = self.make(m);
            if ok {
                self.unmake();
            }
            ok
        }).collect()
    }

    /// Finds the legal move written as UCI (e.g. "e2e4", "e7e8q").
    pub fn parse_uci(&mut self, uci: &str) -> Option<Move> {
        self.legal_moves().into_iter().find(|m| m.uci() == uci)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perft(b: &mut Board, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut moves = Vec::new();
        b.gen_moves(&mut moves, false);
        let mut n = 0;
        for m in moves {
            if b.make(m) {
                n += perft(b, depth - 1);
                b.unmake();
            }
        }
        n
    }

    fn check(fen: &str, depth: u32, expected: u64) {
        let mut b = Board::from_fen(fen).unwrap();
        let hash = b.hash;
        assert_eq!(perft(&mut b, depth), expected, "perft({depth}) of {fen}");
        assert_eq!(b.hash, hash, "hash restored after perft");
        assert_eq!(b.hash, b.compute_hash());
    }

    // Reference counts from https://www.chessprogramming.org/Perft_Results
    #[test]
    fn perft_start() {
        check(START_FEN, 4, 197_281);
    }
    #[test]
    fn perft_kiwipete() {
        check("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3, 97_862);
    }
    #[test]
    fn perft_position3() {
        check("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674_624);
    }
    #[test]
    fn perft_position4() {
        check("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422_333);
    }
    #[test]
    fn perft_position5() {
        check("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62_379);
    }

    #[test]
    fn incremental_hash_matches() {
        let mut b = Board::from_fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1").unwrap();
        for m in b.legal_moves() {
            b.make(m);
            assert_eq!(b.hash, b.compute_hash(), "after {}", m.uci());
            b.unmake();
        }
    }

    #[test]
    fn repetition_detected() {
        let mut b = Board::from_fen(START_FEN).unwrap();
        for uci in ["g1f3", "g8f6", "f3g1", "f6g8"] {
            let m = b.parse_uci(uci).unwrap();
            b.make(m);
        }
        assert!(b.is_repetition());
    }
}
