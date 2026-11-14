// Stockfish, bundled as a separate program ("sidecar", see scripts/fetch-stockfish.mjs),
// grades moves for game review. Stalemate's own engine (engine/) still plays the bot.
// One Stockfish process is started on first use and kept running; requests take
// turns on it.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

/// Scores past this are mates: MATE less the distance in plies (the same scale as engine/).
const MATE: i32 = 30_000;

pub struct Analysis {
    /// For the side to move, in centipawns (mates near ±MATE).
    pub score: i32,
    /// Stockfish's best move (UCI); None if there are no legal moves.
    pub best: Option<String>,
    /// The second-best move's score (same view); None with only one legal move.
    pub second: Option<i32>,
}

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

static STOCKFISH: Mutex<Option<Process>> = Mutex::new(None);

/// Where the bundled binary is: next to the app's own executable once installed
/// (and in `tauri dev`, which copies it there), else in src-tauri/binaries.
fn binary() -> Option<PathBuf> {
    let name = format!("stockfish{}", std::env::consts::EXE_SUFFIX);
    let beside = std::env::current_exe().ok()?.parent()?.join(&name);
    if beside.exists() {
        return Some(beside);
    }
    let triple = env!("TARGET_TRIPLE");
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("stockfish-{triple}{}", std::env::consts::EXE_SUFFIX));
    dev.exists().then_some(dev)
}

impl Process {
    fn start() -> Result<Process, String> {
        let path = binary().ok_or("Stockfish isn't installed (run: node scripts/fetch-stockfish.mjs)")?;
        let mut cmd = Command::new(path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window pops up
        }
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start Stockfish: {e}"))?;
        let input = child.stdin.take().ok_or("no stdin")?;
        let output = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut p = Process { child, input, output };
        // Leave a core free for the bot and the window.
        let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(1).clamp(1, 8)).unwrap_or(2);
        p.send("uci")?;
        p.wait_for("uciok")?;
        p.send(&format!("setoption name Threads value {threads}"))?;
        p.send("setoption name Hash value 64")?;
        // Also the runner-up, to tell an only-good move from one of several fine ones.
        p.send("setoption name MultiPV value 2")?;
        p.send("isready")?;
        p.wait_for("readyok")?;
        Ok(p)
    }

    fn send(&mut self, line: &str) -> Result<(), String> {
        writeln!(self.input, "{line}").and_then(|_| self.input.flush()).map_err(|e| format!("Stockfish stopped: {e}"))
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        match self.output.read_line(&mut line) {
            Ok(0) => Err("Stockfish stopped".into()),
            Ok(_) => Ok(line.trim_end().to_string()),
            Err(e) => Err(format!("Stockfish stopped: {e}")),
        }
    }

    fn wait_for(&mut self, prefix: &str) -> Result<(), String> {
        while !self.read_line()?.starts_with(prefix) {}
        Ok(())
    }

    fn analyse(&mut self, fen: &str, moves: &[String], ms: u64) -> Result<Analysis, String> {
        let position = if moves.is_empty() { format!("position fen {fen}") } else { format!("position fen {fen} moves {}", moves.join(" ")) };
        self.send(&position)?;
        self.send(&format!("go movetime {ms}"))?;
        let mut score = 0;
        let mut second = None;
        loop {
            let line = self.read_line()?;
            if let Some(rest) = line.strip_prefix("bestmove ") {
                let mv = rest.split_whitespace().next().unwrap_or("(none)");
                let best = (mv != "(none)").then(|| mv.to_string());
                return Ok(Analysis { score, best, second });
            }
            if line.starts_with("info") && !line.contains("bound") {
                if let Some(s) = parse_score(&line) {
                    // Lines come per line of play: "multipv 1" is the best, "multipv 2" the runner-up.
                    if line.contains(" multipv 2 ") {
                        second = Some(s);
                    } else {
                        score = s;
                    }
                }
            }
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.kill();
    }
}

/// The score in an "info ... score cp X" / "score mate N" line, for the side to move.
fn parse_score(line: &str) -> Option<i32> {
    let mut words = line.split_whitespace();
    while let Some(w) = words.next() {
        if w == "score" {
            let kind = words.next()?;
            let n: i32 = words.next()?.parse().ok()?;
            return Some(match kind {
                "cp" => n,
                // Mate in n moves (negative: being mated), as MATE less the distance in plies.
                "mate" if n > 0 => MATE - (2 * n - 1),
                "mate" => -(MATE + 2 * n),
                _ => return None,
            });
        }
    }
    None
}

/// Analyses the position after `moves` (UCI) from `fen` for about `ms` milliseconds.
pub fn analyse(fen: &str, moves: &[String], ms: u64) -> Result<Analysis, String> {
    let mut guard = STOCKFISH.lock().map_err(|_| "Stockfish is unavailable")?;
    if guard.is_none() {
        *guard = Some(Process::start()?);
    }
    let result = guard.as_mut().unwrap().analyse(fen, moves, ms);
    if result.is_err() {
        *guard = None; // it died; start a fresh one next time
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_scores() {
        assert_eq!(parse_score("info depth 14 seldepth 20 multipv 1 score cp 896 nodes 1"), Some(896));
        assert_eq!(parse_score("info depth 9 score mate 2 nodes 5"), Some(MATE - 3));
        assert_eq!(parse_score("info depth 9 score mate -1 nodes 5"), Some(-(MATE - 2)));
    }

    #[test]
    fn analyses_with_the_bundled_binary() {
        if binary().is_none() {
            eprintln!("skipped: Stockfish not downloaded");
            return;
        }
        // Black's queen hangs to Nxh4.
        let a = analyse("rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", &[], 150).unwrap();
        assert_eq!(a.best.as_deref(), Some("f3h4"));
        assert!(a.score > 500, "score {}", a.score);
        // Only Nxh4 wins the queen: the runner-up is far behind.
        assert!(a.second.is_some_and(|s| s < a.score - 500), "second {:?}", a.second);
        // Checkmated: no best move.
        let mated = analyse("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", &[], 50).unwrap();
        assert!(mated.best.is_none());
    }
}
