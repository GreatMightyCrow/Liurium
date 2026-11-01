pub mod commands;
pub mod domain;
#[cfg(feature = "e2e")]
mod e2e;
mod frame;
pub mod storage;
#[cfg(test)]
mod test_support;
mod theme;
mod window;

use std::path::PathBuf;

use commands::{Startup, Workspace};
use tauri::{App, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Every command here needs its permission (build.rs, capabilities, ADR-0018).
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::projects::current_project,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::projects::rename_project,
            commands::projects::remove_project,
            commands::projects::locate_project
        ])
        .setup(|app| {
            let app_dir = app_data_dir(app);
            let startup = Startup::open(app_dir.as_deref());
            app.manage(Workspace::new(app_dir, &startup.data));
            app.manage(startup);
            window::create_main_window(app.handle())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn app_data_dir(app: &App) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(dir) = e2e::data_dir() {
        return Some(dir);
    }
    app.path().app_local_data_dir().ok()
}
