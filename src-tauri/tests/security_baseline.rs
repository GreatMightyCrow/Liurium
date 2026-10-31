//! Guards the Tauri security baseline from M0-005. A failure here means a config
//! change widened what the webview may do. Update the expectations only together
//! with a documented reason in the security model.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// CSP sources the webview may use: its own bundle and Tauri's IPC channel.
const ALLOWED_CSP_SOURCES: [&str; 4] = ["'self'", "'none'", "ipc:", "http://ipc.localhost"];

/// Permissions with a row in the security model's permission table.
const REVIEWED_PERMISSIONS: [&str; 5] = [
    // The window buttons of the custom frame styles (M1-009, ADR-0013).
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
    // App commands (M2-004, ADR-0018).
    "allow-app-info",
];

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("invalid JSON in {}: {e}", path.display()))
}

#[test]
fn csp_allows_only_local_sources() {
    let config = read_json(&manifest_path("tauri.conf.json"));
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("csp must be set as a string");

    for directive in csp.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        let mut parts = directive.split_whitespace();
        let name = parts.next().unwrap_or_default();
        for source in parts {
            assert!(
                ALLOWED_CSP_SOURCES.contains(&source),
                "{name} allows unexpected source {source}"
            );
        }
    }
}

#[test]
fn hardening_flags_are_set() {
    let config = read_json(&manifest_path("tauri.conf.json"));
    assert_eq!(
        config["app"]["security"]["freezePrototype"],
        Value::Bool(true)
    );
    assert_ne!(config["app"]["withGlobalTauri"], Value::Bool(true));
}

/// Every permission granted by any capability file, with the file it came from.
fn granted_permissions() -> Vec<(PathBuf, String)> {
    // Tauri loads every file in this folder, so check all of them.
    let dir = manifest_path("capabilities");
    let mut granted = Vec::new();
    for entry in fs::read_dir(&dir).expect("capabilities folder must exist") {
        let path = entry.expect("readable directory entry").path();
        let capability = read_json(&path);
        let permissions = capability["permissions"]
            .as_array()
            .unwrap_or_else(|| panic!("{} has no permissions array", path.display()));
        for permission in permissions {
            let id = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap_or("<invalid>");
            granted.push((path.clone(), id.to_owned()));
        }
    }
    granted
}

/// The command names inside `generate_handler![...]` in `lib.rs`.
fn registered_commands() -> Vec<String> {
    let source = fs::read_to_string(manifest_path("src/lib.rs")).expect("lib.rs");
    let start = source
        .find("generate_handler![")
        .expect("lib.rs registers its commands with generate_handler!")
        + "generate_handler![".len();
    let end = start + source[start..].find(']').expect("closing bracket");
    source[start..end]
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| path.rsplit("::").next().unwrap_or(path).to_owned())
        .collect()
}

#[test]
fn capabilities_grant_only_reviewed_permissions() {
    for (path, id) in granted_permissions() {
        assert!(
            REVIEWED_PERMISSIONS.contains(&id.as_str()),
            "{} grants unreviewed permission {id}",
            path.display()
        );
    }
}

#[test]
fn every_registered_command_has_a_permission() {
    // Tauri rejects a command without a granted permission (app manifest in build.rs),
    // so a missing entry would only show up as a failure in the running app.
    let build = fs::read_to_string(manifest_path("build.rs")).expect("build.rs");
    let granted: Vec<String> = granted_permissions()
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    let commands = registered_commands();
    assert!(!commands.is_empty(), "no commands found in lib.rs");
    for command in commands {
        assert!(
            build.contains(&format!("\"{command}\"")),
            "{command} is missing from COMMANDS in build.rs"
        );
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(
            granted.contains(&permission),
            "{command} needs {permission} in a capability"
        );
    }
}
