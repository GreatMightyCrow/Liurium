pub mod commands;
mod frame;
pub mod storage;
mod theme;
mod window;

use commands::Startup;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Every command here needs its permission (build.rs, capabilities, ADR-0018).
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .setup(|app| {
            let app_dir = app.path().app_local_data_dir().ok();
            app.manage(Startup::open(app_dir.as_deref()));
            window::create_main_window(app.handle())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
