//! Local storage: a read-only puzzle database shipped with the app, and a
//! per-user database (progress, rating, settings) in the app data folder.
//! They are separate files so the puzzle set can be replaced on updates
//! without touching the player's history.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::glicko2::{self, Rating};

pub type Result<T> = rusqlite::Result<T>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Puzzle {
    pub id: String,
    pub fen: String,
    pub moves: String,
    pub rating: i64,
    pub themes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub rating: f64,
    pub rd: f64,
    pub solved: i64,
    pub attempted: i64,
    pub streak: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptResult {
    /// Only the first attempt at a puzzle changes the rating.
    pub rated: bool,
    pub rating_before: f64,
    pub rating_after: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCount {
    pub name: String,
    pub count: i64,
}

const USER_SCHEMA_VERSION: i64 = 1;

pub struct Store {
    puzzles: Connection,
    user: Connection,
}

impl Store {
    pub fn open(puzzles_path: &Path, user_path: &Path) -> Result<Self> {
        let puzzles = Connection::open_with_flags(
            puzzles_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let user = Connection::open(user_path)?;
        Self::from_connections(puzzles, user)
    }

    fn from_connections(puzzles: Connection, user: Connection) -> Result<Self> {
        user.pragma_update(None, "journal_mode", "WAL")?;
        // Flush every commit to disk, so a result or setting survives a crash or power loss.
        user.pragma_update(None, "synchronous", "FULL")?;
        migrate_user(&user)?;
        Ok(Store { puzzles, user })
    }

    pub fn rating(&self) -> Result<Rating> {
        Ok(self
            .user
            .query_row("SELECT rating, rd, vol FROM profile WHERE id = 1", [], |r| {
                Ok(Rating { rating: r.get(0)?, rd: r.get(1)?, vol: r.get(2)? })
            })
            .optional()?
            .unwrap_or_default())
    }

    /// Picks an unattempted puzzle near `target` rating, widening the search
    /// window until one is found. Falls back to repeats once everything in
    /// range has been played.
    pub fn next_puzzle(&self, target: i64, theme: Option<&str>, exclude: Option<&str>) -> Result<Option<Puzzle>> {
        let mut window = 75;
        while window <= 4000 {
            for id in self.candidates(target - window, target + window, theme)? {
                if Some(id.as_str()) != exclude && !self.attempted(&id)? {
                    return self.puzzle(&id);
                }
            }
            window *= 2;
        }
        let all = self.candidates(i64::MIN, i64::MAX, theme)?;
        match all.iter().find(|id| Some(id.as_str()) != exclude).or(all.first()) {
            Some(id) => self.puzzle(id),
            None => Ok(None),
        }
    }

    fn candidates(&self, lo: i64, hi: i64, theme: Option<&str>) -> Result<Vec<String>> {
        let ids = match theme {
            Some(theme) => {
                let mut stmt = self.puzzles.prepare_cached(
                    "SELECT p.id FROM puzzle_themes pt
                     JOIN themes t ON t.id = pt.theme_id
                     JOIN puzzles p ON p.id = pt.puzzle_id
                     WHERE t.name = ?1 AND p.rating BETWEEN ?2 AND ?3
                     ORDER BY random() LIMIT 40",
                )?;
                stmt.query_map(params![theme, lo, hi], |r| r.get(0))?.collect::<Result<_>>()?
            }
            None => {
                let mut stmt = self.puzzles.prepare_cached(
                    "SELECT id FROM puzzles WHERE rating BETWEEN ?1 AND ?2 ORDER BY random() LIMIT 40",
                )?;
                stmt.query_map(params![lo, hi], |r| r.get(0))?.collect::<Result<_>>()?
            }
        };
        Ok(ids)
    }

    fn attempted(&self, puzzle_id: &str) -> Result<bool> {
        let mut stmt = self.user.prepare_cached("SELECT 1 FROM attempts WHERE puzzle_id = ?1 LIMIT 1")?;
        stmt.exists([puzzle_id])
    }

    pub fn puzzle(&self, id: &str) -> Result<Option<Puzzle>> {
        self.puzzles
            .query_row(
                "SELECT id, fen, moves, rating, themes FROM puzzles WHERE id = ?1",
                [id],
                |r| {
                    let themes: String = r.get(4)?;
                    Ok(Puzzle {
                        id: r.get(0)?,
                        fen: r.get(1)?,
                        moves: r.get(2)?,
                        rating: r.get(3)?,
                        themes: themes.split_whitespace().map(str::to_owned).collect(),
                    })
                },
            )
            .optional()
    }

    pub fn record_attempt(&mut self, puzzle_id: &str, solved: bool, used_hint: bool) -> Result<AttemptResult> {
        let (puzzle_rating, puzzle_rd): (f64, f64) = self.puzzles.query_row(
            "SELECT rating, rd FROM puzzles WHERE id = ?1",
            [puzzle_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let before = self.rating()?;
        let rated = !self.attempted(puzzle_id)?;
        let after = if rated {
            let score = if solved && !used_hint { 1.0 } else { 0.0 };
            glicko2::update(before, puzzle_rating, puzzle_rd, score)
        } else {
            before
        };

        let tx = self.user.transaction()?;
        tx.execute(
            "INSERT INTO attempts (puzzle_id, puzzle_rating, solved, used_hint, rated, rating_before, rating_after, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![puzzle_id, puzzle_rating, solved, used_hint, rated, before.rating, after.rating, now()],
        )?;
        tx.execute(
            "INSERT INTO profile (id, rating, rd, vol) VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET rating = ?1, rd = ?2, vol = ?3",
            params![after.rating, after.rd, after.vol],
        )?;
        tx.commit()?;

        Ok(AttemptResult { rated, rating_before: before.rating, rating_after: after.rating })
    }

    pub fn profile(&self) -> Result<Profile> {
        let rating = self.rating()?;
        let (solved, attempted): (i64, i64) = self.user.query_row(
            "SELECT COALESCE(SUM(solved AND NOT used_hint), 0), COUNT(*) FROM attempts WHERE rated",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let streak: i64 = self.user.query_row(
            "SELECT COUNT(*) FROM attempts
             WHERE rated AND id > COALESCE((SELECT MAX(id) FROM attempts WHERE rated AND NOT (solved AND NOT used_hint)), 0)",
            [],
            |r| r.get(0),
        )?;
        Ok(Profile { rating: rating.rating, rd: rating.rd, solved, attempted, streak })
    }

    pub fn themes(&self) -> Result<Vec<ThemeCount>> {
        let mut stmt = self.puzzles.prepare("SELECT name, count FROM themes ORDER BY count DESC")?;
        let rows = stmt.query_map([], |r| Ok(ThemeCount { name: r.get(0)?, count: r.get(1)? }))?;
        rows.collect()
    }

    pub fn settings(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.user.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.user.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }
}

fn migrate_user(conn: &Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY,
                puzzle_id TEXT NOT NULL,
                puzzle_rating INTEGER NOT NULL,
                solved INTEGER NOT NULL,
                used_hint INTEGER NOT NULL,
                rated INTEGER NOT NULL,
                rating_before REAL NOT NULL,
                rating_after REAL NOT NULL,
                ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attempts_puzzle ON attempts(puzzle_id);
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                rating REAL NOT NULL,
                rd REAL NOT NULL,
                vol REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
    }
    conn.pragma_update(None, "user_version", USER_SCHEMA_VERSION)?;
    Ok(())
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> Store {
        test_store_with_user(Connection::open_in_memory().unwrap())
    }

    fn test_store_with_user(user: Connection) -> Store {
        let puzzles = Connection::open_in_memory().unwrap();
        puzzles
            .execute_batch(
                "CREATE TABLE puzzles (id TEXT PRIMARY KEY, fen TEXT, moves TEXT, rating INTEGER, rd INTEGER,
                    popularity INTEGER, nb_plays INTEGER, themes TEXT);
                 CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT, count INTEGER);
                 CREATE TABLE puzzle_themes (theme_id INTEGER, puzzle_id TEXT, PRIMARY KEY (theme_id, puzzle_id));
                 INSERT INTO puzzles VALUES ('a', 'fen-a', 'e2e4 e7e5', 1500, 75, 90, 1000, 'fork short');
                 INSERT INTO puzzles VALUES ('b', 'fen-b', 'e2e4 e7e5', 1520, 75, 90, 1000, 'mateIn1');
                 INSERT INTO puzzles VALUES ('c', 'fen-c', 'e2e4 e7e5', 2600, 75, 90, 1000, 'fork');
                 INSERT INTO themes VALUES (1, 'fork', 2), (2, 'short', 1), (3, 'mateIn1', 1);
                 INSERT INTO puzzle_themes VALUES (1, 'a'), (1, 'c'), (2, 'a'), (3, 'b');",
            )
            .unwrap();
        Store::from_connections(puzzles, user).unwrap()
    }

    /// Rating, history and settings written in one session are there after reopening the file.
    #[test]
    fn progress_survives_reopen() {
        let path = std::env::temp_dir().join(format!("stalemate-test-{}.db", std::process::id()));
        let cleanup = || {
            for ext in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
            }
        };
        cleanup();

        let rating_after = {
            let mut s = test_store_with_user(Connection::open(&path).unwrap());
            s.set_setting("boardTheme", "slate").unwrap();
            s.set_setting("clickToMove", "false").unwrap();
            s.record_attempt("a", true, false).unwrap().rating_after
        }; // dropped: connection closed

        let s = test_store_with_user(Connection::open(&path).unwrap());
        let p = s.profile().unwrap();
        assert_eq!(p.rating, rating_after);
        assert!(p.rating > 1500.0);
        assert_eq!((p.solved, p.attempted, p.streak), (1, 1, 1));
        let settings = s.settings().unwrap();
        assert_eq!(settings["boardTheme"], "slate");
        assert_eq!(settings["clickToMove"], "false");
        assert!(s.attempted("a").unwrap());
        cleanup();
    }

    #[test]
    fn picks_near_rating_and_skips_attempted() {
        let mut s = test_store();
        let first = s.next_puzzle(1500, None, None).unwrap().unwrap();
        assert!(first.id == "a" || first.id == "b");
        s.record_attempt(&first.id, true, false).unwrap();
        let second = s.next_puzzle(1500, None, None).unwrap().unwrap();
        assert_ne!(second.id, first.id);
        assert_ne!(second.id, "c");
    }

    #[test]
    fn theme_filter_and_window_widening() {
        let s = test_store();
        let p = s.next_puzzle(1500, Some("fork"), Some("a")).unwrap().unwrap();
        assert_eq!(p.id, "c");
        assert_eq!(p.themes, vec!["fork"]);
    }

    #[test]
    fn only_first_attempt_is_rated() {
        let mut s = test_store();
        let r1 = s.record_attempt("a", true, false).unwrap();
        assert!(r1.rated && r1.rating_after > r1.rating_before);
        let r2 = s.record_attempt("a", false, false).unwrap();
        assert!(!r2.rated);
        assert_eq!(r2.rating_after, r2.rating_before);
    }

    #[test]
    fn hint_counts_as_failure_and_resets_streak() {
        let mut s = test_store();
        s.record_attempt("a", true, false).unwrap();
        assert_eq!(s.profile().unwrap().streak, 1);
        let r = s.record_attempt("b", true, true).unwrap();
        assert!(r.rating_after < r.rating_before);
        let p = s.profile().unwrap();
        assert_eq!((p.solved, p.attempted, p.streak), (1, 2, 0));
    }

    /// Runs against the real puzzle set when it has been built.
    #[test]
    fn real_puzzle_db() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/puzzles.db");
        if !path.exists() {
            return;
        }
        let puzzles = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let s = Store::from_connections(puzzles, Connection::open_in_memory().unwrap()).unwrap();
        let p = s.next_puzzle(1500, None, None).unwrap().unwrap();
        assert!((1300..=1700).contains(&p.rating));
        assert!(p.moves.split(' ').count() >= 2);
        let fork = s.next_puzzle(1200, Some("fork"), None).unwrap().unwrap();
        assert!(fork.themes.iter().any(|t| t == "fork"));
        assert!(s.themes().unwrap().len() > 30);
    }

    #[test]
    fn settings_round_trip() {
        let s = test_store();
        s.set_setting("boardTheme", "walnut").unwrap();
        s.set_setting("boardTheme", "slate").unwrap();
        assert_eq!(s.settings().unwrap()["boardTheme"], "slate");
    }
}
