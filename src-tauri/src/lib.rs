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

use commands::{Preferences, Startup, Workspace};
use tauri::{App, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second start ends before anything else is set up and never opens
        // app.db (M2-010). Its working folder and arguments are untrusted and ignored.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::focus(app);
        }))
        // Every command here needs its permission (build.rs, capabilities, ADR-0018).
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::projects::current_project,
            commands::projects::add_project,
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::projects::rename_project,
            commands::projects::remove_project,
            commands::projects::locate_project,
            commands::projects::separate_project_copy,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::restart_app,
            commands::data::app_data_info,
            commands::data::open_app_data_folder,
            commands::data::prune_backups,
            commands::data::reset_sync_warnings,
            commands::notes::list_notes,
            commands::editor::open_note,
            commands::editor::update_note,
            commands::editor::resolve_note_conflict,
            commands::editor::close_note,
            commands::organize::create_note,
            commands::organize::create_folder,
            commands::organize::rename_entry,
            commands::organize::move_entry,
            commands::organize::trash_entry,
            commands::links::note_links,
            commands::links::backlinks,
            commands::links::project_tags,
            commands::properties::edit_property,
            commands::properties::property_kinds,
            commands::properties::set_property_kind,
            commands::changes::wait_note_changes,
            commands::changes::check_note_changes,
            commands::editor::reconcile_note,
            commands::closing::wait_close_question,
            commands::closing::answer_close_question,
            commands::links::open_external_link,
            commands::search::search_notes,
            commands::tasks::task_board,
            commands::tasks::trashed_tasks,
            commands::tasks::task_detail,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::move_task,
            commands::tasks::trash_task,
            commands::tasks::restore_task,
            commands::tasks::delete_task,
            commands::tasks::create_column,
            commands::tasks::rename_column,
            commands::tasks::move_column,
            commands::tasks::delete_column
        ])
        // Reachable from the page without a permission, so it is reviewed like a command:
        // only images the walk listed, in the open project (M3-013).
        .register_asynchronous_uri_scheme_protocol(
            commands::images::SCHEME,
            commands::images::handle,
        )
        // Likewise: only the diagram frame's own page and scripts (M3-011).
        .register_asynchronous_uri_scheme_protocol(
            commands::diagrams::SCHEME,
            commands::diagrams::handle,
        )
        .setup(|app| {
            let app_dir = app_data_dir(app);
            let startup = Startup::open(app_dir.as_deref());
            let settings = startup.settings.settings;
            app.manage(Workspace::new(
                app_dir,
                &startup.data,
                sync_roots(),
                settings.startup,
            ));
            app.manage(Preferences::new(startup.settings.clone()));
            app.manage(startup);
            window::create_main_window(app.handle(), settings)
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

fn sync_roots() -> Vec<domain::sync::SyncRoot> {
    #[cfg(feature = "e2e")]
    return e2e::sync_roots();
    #[cfg(not(feature = "e2e"))]
    domain::sync::detect()
}
