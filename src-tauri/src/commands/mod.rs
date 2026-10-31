//! Commands the page may call (ADR-0018). Each one is registered in `lib.rs`, listed
//! in `build.rs`, and granted in `capabilities/default.json`; `security_baseline.rs`
//! fails when a registered command has no permission.

#[cfg(test)]
mod bindings;
mod error;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

pub use error::CommandError;

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
}

impl Startup {
    /// Opens `app.db` so it exists and is migrated from the start (ADR-0016). The app
    /// also starts when this fails; the page shows the status. The connection is
    /// closed again until the first command needs it (M2-005).
    pub fn open(app_dir: Option<&Path>) -> Self {
        let data = match app_dir {
            Some(dir) => DataStatus::of(db::open_app(dir)),
            None => DataStatus::Failed {
                error: CommandError::Internal,
            },
        };
        Self { data }
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
