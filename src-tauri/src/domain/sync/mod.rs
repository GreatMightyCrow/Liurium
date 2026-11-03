//! Sync folders (ADR-0016 decision 5, M2-010). A project inside a folder that OneDrive or
//! Dropbox syncs gets one warning: the same project open on two computers can conflict.
//! Nothing is blocked.
//!
//! Where the tools keep their folders on Windows: OneDrive sets the environment variables
//! `OneDrive`, `OneDriveConsumer`, and `OneDriveCommercial`, and lists each account's
//! folder as `UserFolder` under `HKCU\Software\Microsoft\OneDrive\Accounts\<account>`.
//! Dropbox lists its folders in `info.json` under `%APPDATA%\Dropbox` or
//! `%LOCALAPPDATA%\Dropbox` (help.dropbox.com, "Locate the Dropbox folder").

#[cfg(test)]
mod tests;

use std::{
    env,
    ffi::OsString,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::storage::fs as storage_fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SyncTool.ts"))]
pub enum SyncTool {
    OneDrive,
    Dropbox,
}

/// A folder that a sync tool keeps in the cloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncRoot {
    pub tool: SyncTool,
    pub folder: PathBuf,
}

const ONEDRIVE_VARIABLES: [&str; 3] = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];
const ONEDRIVE_ACCOUNTS: &str = r"Software\Microsoft\OneDrive\Accounts";
/// `info.json` holds one entry per account; anything larger is not Dropbox's file.
const MAX_INFO_LEN: u64 = 64 * 1024;

/// The sync folders of the signed-in user, read once at start. A source that cannot be
/// read adds nothing.
pub fn detect() -> Vec<SyncRoot> {
    let mut roots = onedrive_from_env(|name| env::var_os(name));
    roots.extend(onedrive_from_registry());
    for base in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = env::var_os(base) else {
            continue;
        };
        let info = Path::new(&base).join("Dropbox").join("info.json");
        if let Some(text) = read_small(&info) {
            roots.extend(dropbox_from_info(&text));
        }
    }
    // OneDrive names the same folder in several places.
    let mut unique: Vec<SyncRoot> = Vec::new();
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    unique
}

/// The tool that syncs `folder`, if it lies in one of `roots`. Both are compared as
/// Windows resolves them, so a link or a different spelling still matches.
pub fn tool_for(folder: &Path, roots: &[SyncRoot]) -> Option<SyncTool> {
    roots
        .iter()
        .find(|root| storage_fs::inside(&root.folder, folder).unwrap_or(false))
        .map(|root| root.tool)
}

fn onedrive_from_env(var: impl Fn(&str) -> Option<OsString>) -> Vec<SyncRoot> {
    ONEDRIVE_VARIABLES
        .iter()
        .filter_map(|name| var(name))
        .filter_map(|value| root(SyncTool::OneDrive, PathBuf::from(value)))
        .collect()
}

#[cfg(windows)]
fn onedrive_from_registry() -> Vec<SyncRoot> {
    let Ok(accounts) = winreg::HKCU.open_subkey(ONEDRIVE_ACCOUNTS) else {
        return Vec::new();
    };
    accounts
        .enum_keys_os_string()
        .filter_map(Result::ok)
        .filter_map(|name| accounts.open_subkey(name).ok())
        .filter_map(|account| account.get_value::<OsString, _>("UserFolder").ok())
        .filter_map(|folder| root(SyncTool::OneDrive, PathBuf::from(folder)))
        .collect()
}

#[cfg(not(windows))]
fn onedrive_from_registry() -> Vec<SyncRoot> {
    Vec::new()
}

/// `{"personal": {"path": ...}, "business": {"path": ...}}`. Other shapes add nothing.
fn dropbox_from_info(text: &str) -> Vec<SyncRoot> {
    let Ok(serde_json::Value::Object(accounts)) = serde_json::from_str(text) else {
        return Vec::new();
    };
    accounts
        .values()
        .filter_map(|account| account.get("path")?.as_str())
        .filter_map(|path| root(SyncTool::Dropbox, PathBuf::from(path)))
        .collect()
}

/// Only absolute folders count; an empty or relative value would match the wrong place.
fn root(tool: SyncTool, folder: PathBuf) -> Option<SyncRoot> {
    folder.is_absolute().then_some(SyncRoot { tool, folder })
}

fn read_small(path: &Path) -> Option<String> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(MAX_INFO_LEN + 1)
        .read_to_string(&mut text)
        .ok()?;
    (u64::try_from(text.len()).ok()? <= MAX_INFO_LEN).then_some(text)
}
