//! NexusCore desktop shell.
//!
//! Phase A: this file wires up the native window, the plugins we need
//! across the rest of the productization phases (filesystem access for
//! backup export, dialogs for backup upload, OS info, window-state
//! persistence), and a couple of Tauri commands the React side calls
//! through `src/lib/tauri.ts` to discover the per-user app data
//! directory and the running app version.
//!
//! Phase B (done) registers `tauri-plugin-sql` as the ledger *read* path
//! and an owned sqlx pool as the *write* path — see `ledger.rs` and
//! docs/LEDGER_SCHEMA.md §4 for why writes cannot go through the plugin.
//! Phase C will add `tauri-plugin-updater`. The hooks are intentionally
//! narrow so the surface stays easy to audit.

pub mod ledger;

use tauri::Manager;

#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_app_name(app: tauri::AppHandle) -> String {
    app.package_info().name.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Filesystem — used by Phase A backup export/import flows
        .plugin(tauri_plugin_fs::init())
        // Dialogs — used by the backup page for file pickers
        .plugin(tauri_plugin_dialog::init())
        // Shell — used for "open external URL" calls
        .plugin(tauri_plugin_shell::init())
        // OS — used to read host info for the license fingerprint
        .plugin(tauri_plugin_os::init())
        // Window state — remembers position/size across launches
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // SQL — the ledger READ path only. Writes go through ledger_append.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_app_data_dir,
            get_app_version,
            get_app_name,
            ledger::ledger_append,
            ledger::ledger_identity,
            ledger::ledger_retag_store,
            ledger::ledger_db_path,
            ledger::dev_reset_ledger,
        ])
        .setup(|app| {
            // Ensure the app data directory exists on first run. Tauri
            // creates it lazily for some platforms but not for all; being
            // explicit avoids a first-launch race.
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
            }

            // Open the ledger and apply the schema before any window script
            // can call into it. Failing here is fatal: without the ledger
            // there is no source of truth to run the app against.
            let db_path = app
                .path()
                .app_config_dir()
                .expect("no app config dir")
                .join(ledger::DB_FILENAME);
            let db = tauri::async_runtime::block_on(ledger::open(db_path))
                .expect("failed to open the ledger database");
            app.manage(db);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NexusCore desktop");
}
