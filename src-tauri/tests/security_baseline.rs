//! Guards the Tauri security baseline from M0-005. A failure here means a config
//! change widened what the webview may do. Update the expectations only together
//! with a documented reason in the security model.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// CSP sources the webview may use: its own bundle and Tauri's IPC channel.
const ALLOWED_CSP_SOURCES: [&str; 4] = ["'self'", "'none'", "ipc:", "http://ipc.localhost"];

/// Permissions with a row in the security model's permission table.
/// The window buttons of the custom frame styles (M1-009, ADR-0013).
const REVIEWED_PERMISSIONS: [&str; 4] = [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
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

#[test]
fn capabilities_grant_only_reviewed_permissions() {
    // Tauri loads every file in this folder, so check all of them.
    let dir = manifest_path("capabilities");
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
            assert!(
                REVIEWED_PERMISSIONS.contains(&id),
                "{} grants unreviewed permission {id}",
                path.display()
            );
        }
    }
}
