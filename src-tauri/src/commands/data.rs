//! The app data folder (M3-009): where it is, its backup copies, the sync-folder
//! warnings, and opening it in Explorer. No command takes an argument: the folder is
//! the one Rust chose at start, so the page cannot name another path.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::projects;
use crate::storage::db::backups;

/// The newest backup copies that pruning keeps (owner, 2026-11-04).
pub const KEPT_BACKUPS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "AppDataInfo.ts"))]
pub struct AppDataInfo {
    /// As Windows shows it; for display only.
    pub folder: String,
    pub backups: usize,
    #[cfg_attr(test, ts(type = "number"))]
    pub backup_bytes: u64,
    /// How many copies pruning keeps.
    pub kept_backups: usize,
    /// Projects that have shown their sync-folder warning.
    pub sync_warned: usize,
}

impl Workspace {
    pub fn data_info(&self) -> Result<AppDataInfo, CommandError> {
        let app = self.app()?;
        let dir = self.app_dir()?;
        let summary = backups::summary(dir)?;
        Ok(AppDataInfo {
            folder: dir.display().to_string(),
            backups: summary.copies,
            backup_bytes: summary.bytes,
            kept_backups: KEPT_BACKUPS,
            sync_warned: projects::sync_warned(&app)?,
        })
    }

    /// Deletes the older backup copies; the page asks the user first.
    pub fn prune_backups(&self) -> Result<AppDataInfo, CommandError> {
        // Through `app()` first, so a missing or broken app data folder reports why.
        self.app()?;
        backups::prune(self.app_dir()?, KEPT_BACKUPS)?;
        self.data_info()
    }

    pub fn reset_sync_warnings(&self) -> Result<AppDataInfo, CommandError> {
        projects::reset_sync_warnings(&self.app()?)?;
        self.data_info()
    }
}

/// `explorer.exe` from the Windows folder, never through `PATH`, with the folder as
/// its one argument. Explorer splits unquoted arguments at commas, so the folder is
/// passed in quotes; a Windows path cannot contain a quote itself.
pub(super) fn explorer(folder: &Path) -> Result<Command, CommandError> {
    use std::os::windows::process::CommandExt;

    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .ok_or(CommandError::Internal)?;
    let argument = quoted(folder).ok_or(CommandError::InvalidPath)?;
    let mut command = Command::new(windows.join("explorer.exe"));
    command.raw_arg(argument);
    Ok(command)
}

pub(super) fn quoted(folder: &Path) -> Option<String> {
    let text = folder.to_str()?;
    (!text.contains('"')).then(|| format!("\"{text}\""))
}

#[tauri::command]
pub async fn app_data_info(workspace: State<'_, Workspace>) -> Result<AppDataInfo, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.data_info()).await
}

#[tauri::command]
pub async fn prune_backups(workspace: State<'_, Workspace>) -> Result<AppDataInfo, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.prune_backups()).await
}

#[tauri::command]
pub async fn reset_sync_warnings(
    workspace: State<'_, Workspace>,
) -> Result<AppDataInfo, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.reset_sync_warnings()).await
}

/// Starts Explorer and returns; Explorer's exit code says nothing about success.
#[tauri::command]
pub async fn open_app_data_folder(workspace: State<'_, Workspace>) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || {
        let dir = workspace.app_dir()?;
        if !dir.is_dir() {
            return Err(CommandError::NotFound);
        }
        explorer(dir)?
            .spawn()
            .map(drop)
            .map_err(|_| CommandError::Internal)
    })
    .await
}
