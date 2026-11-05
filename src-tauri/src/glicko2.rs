//! Glicko-2 rating update for a single game (player vs. puzzle).
//! See Glickman, "Example of the Glicko-2 system" (2013).

use std::f64::consts::PI;

const SCALE: f64 = 173.7178;
/// System constant; Lichess uses 0.75 for puzzles so ratings settle quickly.
const TAU: f64 = 0.75;
const EPSILON: f64 = 1e-6;
/// Floor for RD so a player's rating keeps responding to recent results.
pub const MIN_RD: f64 = 60.0;
pub const MAX_RD: f64 = 350.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rating {
    pub rating: f64,
    pub rd: f64,
    pub vol: f64,
}

impl Default for Rating {
    fn default() -> Self {
        Rating { rating: 1500.0, rd: MAX_RD, vol: 0.06 }
    }
}

/// Returns the player's new rating after one result against an opponent
/// with the given rating and RD. `score` is 1.0 for a win, 0.0 for a loss.
pub fn update(player: Rating, opp_rating: f64, opp_rd: f64, score: f64) -> Rating {
    let mu = (player.rating - 1500.0) / SCALE;
    let phi = player.rd / SCALE;
    let mu_j = (opp_rating - 1500.0) / SCALE;
    let phi_j = opp_rd / SCALE;

    let g = 1.0 / (1.0 + 3.0 * phi_j * phi_j / (PI * PI)).sqrt();
    let e = 1.0 / (1.0 + (-g * (mu - mu_j)).exp());
    let v = 1.0 / (g * g * e * (1.0 - e));
    let delta = v * g * (score - e);

    // Step 5: new volatility via the Illinois algorithm.
    let a = (player.vol * player.vol).ln();
    let f = |x: f64| {
        let ex = x.exp();
        let d = phi * phi + v + ex;
        ex * (delta * delta - phi * phi - v - ex) / (2.0 * d * d) - (x - a) / (TAU * TAU)
    };
    let mut big_a = a;
    let mut big_b = if delta * delta > phi * phi + v {
        (delta * delta - phi * phi - v).ln()
    } else {
        let mut k = 1.0;
        while f(a - k * TAU) < 0.0 {
            k += 1.0;
        }
        a - k * TAU
    };
    let mut f_a = f(big_a);
    let mut f_b = f(big_b);
    while (big_b - big_a).abs() > EPSILON {
        let c = big_a + (big_a - big_b) * f_a / (f_b - f_a);
        let f_c = f(c);
        if f_c * f_b <= 0.0 {
            big_a = big_b;
            f_a = f_b;
        } else {
            f_a /= 2.0;
        }
        big_b = c;
        f_b = f_c;
    }
    let vol = (big_a / 2.0).exp();

    let phi_star = (phi * phi + vol * vol).sqrt();
    let new_phi = 1.0 / (1.0 / (phi_star * phi_star) + 1.0 / v).sqrt();
    let new_mu = mu + new_phi * new_phi * g * (score - e);

    Rating {
        rating: new_mu * SCALE + 1500.0,
        rd: (new_phi * SCALE).clamp(MIN_RD, MAX_RD),
        vol,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_raises_and_loss_lowers() {
        let p = Rating::default();
        assert!(update(p, 1500.0, 75.0, 1.0).rating > 1500.0);
        assert!(update(p, 1500.0, 75.0, 0.0).rating < 1500.0);
    }

    #[test]
    fn beating_stronger_opponent_gains_more() {
        let p = Rating { rating: 1500.0, rd: 100.0, vol: 0.06 };
        let vs_strong = update(p, 1800.0, 75.0, 1.0).rating - 1500.0;
        let vs_weak = update(p, 1200.0, 75.0, 1.0).rating - 1500.0;
        assert!(vs_strong > vs_weak);
    }

    #[test]
    fn matches_glickman_single_game_direction_and_rd_shrinks() {
        let p = Rating { rating: 1500.0, rd: 200.0, vol: 0.06 };
        let r = update(p, 1400.0, 30.0, 1.0);
        assert!(r.rd < 200.0);
        assert!((r.vol - 0.06).abs() < 0.01);
    }
}
