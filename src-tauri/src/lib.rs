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
            set_setting
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
