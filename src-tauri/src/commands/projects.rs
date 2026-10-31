//! Adding a project and asking which one is open (M2-005). The page never sends a
//! path: the folder comes from the native dialog that Rust shows.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::{State, WebviewWindow};

use super::{CommandError, DataStatus};
use crate::domain::projects::{self, Project};
use crate::storage::db::{self, APP_DB, Kind, OpenMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ProjectInfo.ts"))]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    /// As Windows shows it.
    pub folder: String,
    /// Opened without writing anything (write-protected file or folder).
    pub read_only: bool,
}

impl From<&Project> for ProjectInfo {
    fn from(project: &Project) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            folder: project.root.display(),
            read_only: project.read_only,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CurrentProject.ts"))]
pub enum CurrentProject {
    /// No project yet, or none was open before.
    None,
    Open {
        project: ProjectInfo,
    },
    /// The project open at the last run could not be opened again.
    Unavailable {
        name: String,
        error: CommandError,
    },
}

/// What the page is shown, and the project behind it.
struct Current {
    view: CurrentProject,
    /// Keeps `project.db` open while the project is the current one.
    _open: Option<Project>,
}

impl Current {
    fn open(project: Project) -> Self {
        Self {
            view: CurrentProject::Open {
                project: (&project).into(),
            },
            _open: Some(project),
        }
    }

    fn shown(view: CurrentProject) -> Self {
        Self { view, _open: None }
    }
}

/// The open project, shared by all commands.
#[derive(Clone)]
pub struct Workspace {
    app_dir: Result<PathBuf, CommandError>,
    /// `None` until the first request reopens the project of the last run.
    current: Arc<Mutex<Option<Current>>>,
}

impl Workspace {
    /// Without a usable `app.db` (see `Startup`), every project command reports why.
    pub fn new(app_dir: Option<PathBuf>, data: &DataStatus) -> Self {
        let app_dir = match (app_dir, data) {
            (_, DataStatus::Failed { error }) => Err(error.clone()),
            (None, _) => Err(CommandError::Internal),
            (Some(dir), _) => Ok(dir),
        };
        Self {
            app_dir,
            current: Arc::new(Mutex::new(None)),
        }
    }

    fn app(&self) -> Result<rusqlite::Connection, CommandError> {
        let dir = self.app_dir.as_ref().map_err(Clone::clone)?;
        Ok(db::open(&dir.join(APP_DB), Kind::App, OpenMode::Existing)?)
    }

    /// The open project; on the first call, the one open at the last run.
    pub fn current(&self) -> Result<CurrentProject, CommandError> {
        let mut current = self.current.lock().map_err(|_| CommandError::Internal)?;
        if current.is_none() {
            *current = Some(self.restore()?);
        }
        current
            .as_ref()
            .map(|current| current.view.clone())
            .ok_or(CommandError::Internal)
    }

    fn restore(&self) -> Result<Current, CommandError> {
        let app = self.app()?;
        let Some((id, name)) = projects::last_opened(&app)? else {
            return Ok(Current::shown(CurrentProject::None));
        };
        Ok(match projects::open(&app, &id) {
            Ok(project) => Current::open(project),
            Err(error) => Current::shown(CurrentProject::Unavailable {
                name,
                error: error.into(),
            }),
        })
    }
    /// Adds the folder as a project and makes it the open one.
    pub fn add(&self, folder: &Path) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let project = projects::add(&app, folder)?;
        let info = ProjectInfo::from(&project);
        let mut current = self.current.lock().map_err(|_| CommandError::Internal)?;
        *current = Some(Current::open(project));
        Ok(info)
    }
}

/// Disk work and the dialog block; they run on a thread meant for that, not on the
/// main thread or an async worker (ADR-0018).
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| CommandError::Internal)?
}

#[tauri::command]
pub async fn current_project(
    workspace: State<'_, Workspace>,
) -> Result<CurrentProject, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.current()).await
}

/// Shows the folder dialog and adds the chosen folder. `None` when the user cancels.
#[tauri::command]
pub async fn add_project(
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
) -> Result<Option<ProjectInfo>, CommandError> {
    let Some(folder) = choose_folder(window).await? else {
        return Ok(None);
    };
    let workspace = workspace.inner().clone();
    blocking(move || workspace.add(&folder)).await.map(Some)
}

#[cfg(not(feature = "e2e"))]
async fn choose_folder(window: WebviewWindow) -> Result<Option<PathBuf>, CommandError> {
    blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title("Choose a project folder")
            .set_parent(&window)
            .pick_folder())
    })
    .await
}

#[cfg(feature = "e2e")]
async fn choose_folder(_window: WebviewWindow) -> Result<Option<PathBuf>, CommandError> {
    Ok(crate::e2e::picked_folder())
}
