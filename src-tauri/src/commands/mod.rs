//! Commands the page may call (ADR-0018). Each one is registered in `lib.rs`, listed
//! in `build.rs`, and granted in `capabilities/default.json`; `security_baseline.rs`
//! fails when a registered command has no permission.

#[cfg(test)]
mod bindings;
pub mod changes;
pub mod closing;
pub mod data;
pub mod diagrams;
pub mod editor;
mod error;
pub mod images;
pub mod links;
pub mod notes;
pub mod organize;
pub mod projects;
pub mod properties;
pub mod search;
pub mod settings;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

pub use error::CommandError;
pub use projects::Workspace;
pub use settings::Preferences;

use crate::domain::settings::{self as stored, Loaded};
use crate::storage::db::{self, AppDb, DbError};

/// What the start found in the app data folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "DataStatus.ts"))]
pub enum DataStatus {
    Ready,
    /// A damaged `app.db` was moved to `backups` and replaced by an empty one.
    Recovered,
    Failed {
        error: CommandError,
    },
}

impl DataStatus {
    fn of(opened: Result<AppDb, DbError>) -> Self {
        match opened {
            Ok(AppDb {
                moved_aside: Some(_),
                ..
            }) => Self::Recovered,
            Ok(_) => Self::Ready,
            Err(error) => Self::Failed {
                error: error.into(),
            },
        }
    }
}

/// Set once when the app starts.
pub struct Startup {
    pub data: DataStatus,
    /// Read before the window is created, so its first frame has the stored theme.
    pub settings: Loaded,
}

impl Startup {
    /// Opens `app.db` so it exists and is migrated from the start (ADR-0016), and
    /// reads the settings. The app also starts when this fails, with the default
    /// settings; the page shows the status. The connection is closed again until the
    /// first command needs it (M2-005).
    pub fn open(app_dir: Option<&Path>) -> Self {
        let Some(dir) = app_dir else {
            return Self {
                data: DataStatus::Failed {
                    error: CommandError::Internal,
                },
                settings: Loaded::default(),
            };
        };
        let opened = db::open_app(dir);
        let settings = opened
            .as_ref()
            .ok()
            .and_then(|app| stored::load(&app.connection).ok())
            .unwrap_or_default();
        Self {
            data: DataStatus::of(opened),
            settings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "AppInfo.ts"))]
pub struct AppInfo {
    pub version: String,
    pub data: DataStatus,
}

#[tauri::command]
pub fn app_info(app: AppHandle, startup: State<'_, Startup>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data: startup.data.clone(),
    }
}
