mod engine;
mod stockfish;
mod glicko2;
mod store;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::{Manager, State};

use store::{AttemptResult, Profile, Puzzle, Store, ThemeCount};

type AppStore = Mutex<Store>;
type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// `offset` shifts the target rating for the difficulty setting (e.g. -150 = easier).
#[tauri::command]
fn next_puzzle(
    store: State<AppStore>,
    theme: Option<String>,
    offset: i64,
    exclude: Option<String>,
) -> CmdResult<Option<Puzzle>> {
    let store = store.lock().map_err(err)?;
    let target = store.rating().map_err(err)?.rating.round() as i64 + offset;
    store.next_puzzle(target, theme.as_deref(), exclude.as_deref()).map_err(err)
}

#[tauri::command]
fn get_puzzle(store: State<AppStore>, id: String) -> CmdResult<Option<Puzzle>> {
    store.lock().map_err(err)?.puzzle(&id).map_err(err)
}

#[tauri::command]
fn record_attempt(store: State<AppStore>, puzzle_id: String, solved: bool, used_hint: bool) -> CmdResult<AttemptResult> {
    store.lock().map_err(err)?.record_attempt(&puzzle_id, solved, used_hint).map_err(err)
}

#[tauri::command]
fn get_profile(store: State<AppStore>) -> CmdResult<Profile> {
    store.lock().map_err(err)?.profile().map_err(err)
}

#[tauri::command]
fn list_themes(store: State<AppStore>) -> CmdResult<Vec<ThemeCount>> {
    store.lock().map_err(err)?.themes().map_err(err)
}

#[tauri::command]
fn get_settings(store: State<AppStore>) -> CmdResult<HashMap<String, String>> {
    store.lock().map_err(err)?.settings().map_err(err)
}

#[tauri::command]
fn set_setting(store: State<AppStore>, key: String, value: String) -> CmdResult<()> {
    store.lock().map_err(err)?.set_setting(&key, &value).map_err(err)
}

/// The bot's reply (UCI) after `moves` (UCI) from `fen`, at `level` 1-5; None if the
/// game is over. Runs off the main thread so the window stays responsive.
#[tauri::command]
async fn bot_move(fen: String, moves: Vec<String>, level: u8) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || engine::best_move(&fen, &moves, level))
        .await
        .map_err(err)?
}

/// How `mv` compares with the best move after `moves` from `fen`: [best, mv] in
/// centipawns for the side to move, or None. Used to tell a sound sacrifice from a blunder.
#[tauri::command]
async fn judge_move(fen: String, moves: Vec<String>, mv: String, ms: Option<u64>) -> CmdResult<Option<[i32; 2]>> {
    let ms = ms.unwrap_or(500).clamp(50, 2000);
    tauri::async_runtime::spawn_blocking(move || engine::judge_move(&fen, &moves, &mv, ms).map(|r| r.map(|(b, s)| [b, s])))
        .await
        .map_err(err)?
}

#[derive(serde::Serialize)]
struct PositionAnalysis {
    /// Centipawns for the side to move (mates near ±30000).
    score: i32,
    best: Option<String>,
    /// The second-best move's score; None with only one legal move.
    second: Option<i32>,
}

/// Stockfish's verdict on the position after `moves` from `fen`, searching about
/// `ms` milliseconds: for grading moves (game review). Errors if Stockfish isn't there.
#[tauri::command]
async fn analyse_position(fen: String, moves: Vec<String>, ms: Option<u64>) -> CmdResult<PositionAnalysis> {
    let ms = ms.unwrap_or(250).clamp(20, 3000);
    tauri::async_runtime::spawn_blocking(move || stockfish::analyse(&fen, &moves, ms).map(|a| PositionAnalysis { score: a.score, best: a.best, second: a.second }))
        .await
        .map_err(err)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let puzzles_path = app.path().resolve("puzzles.db", BaseDirectory::Resource)?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = Store::open(&puzzles_path, &data_dir.join("user.db"))?;
            app.manage(Mutex::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            next_puzzle,
            get_puzzle,
            record_attempt,
            get_profile,
            list_themes,
            get_settings,
            set_setting,
            bot_move,
            judge_move,
            analyse_position
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
