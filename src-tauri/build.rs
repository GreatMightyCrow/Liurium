/// App commands (ADR-0018). Each gets an `allow-<name>` and a `deny-<name>` permission
/// (underscores become hyphens). With this manifest, Tauri rejects every app command
/// that the capability does not grant.
const COMMANDS: &[&str] = &[
    "app_info",
    "current_project",
    "add_project",
    "list_projects",
    "open_project",
    "rename_project",
    "remove_project",
    "locate_project",
    "separate_project_copy",
    "get_settings",
    "update_settings",
    "restart_app",
    "app_data_info",
    "open_app_data_folder",
    "prune_backups",
    "reset_sync_warnings",
    "list_notes",
    "open_note",
    "update_note",
    "resolve_note_conflict",
    "close_note",
    "create_note",
    "create_folder",
    "rename_entry",
    "move_entry",
    "trash_entry",
    "note_links",
    "backlinks",
    "project_tags",
    "edit_property",
    "property_kinds",
    "set_property_kind",
    "wait_note_changes",
    "check_note_changes",
    "reconcile_note",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
