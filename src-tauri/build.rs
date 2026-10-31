/// App commands (ADR-0018). Each gets an `allow-<name>` and a `deny-<name>` permission
/// (underscores become hyphens). With this manifest, Tauri rejects every app command
/// that the capability does not grant.
const COMMANDS: &[&str] = &["app_info"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
