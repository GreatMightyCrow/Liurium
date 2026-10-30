mod frame;
pub mod storage;
mod theme;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| window::create_main_window(app.handle()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
