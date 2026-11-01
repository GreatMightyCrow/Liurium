//! Projects: add, open, list, rename, remove, locate (M2-005, M2-006). The page never
//! sends a path: folders come from the native dialog that Rust shows, and projects
//! are named by their id.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
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
    /// No project yet, or none is open.
    None,
    Open {
        project: ProjectInfo,
    },
    /// The project open at the last run could not be opened again.
    Unavailable {
        id: String,
        name: String,
        error: CommandError,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ProjectStatus.ts"))]
pub enum ProjectStatus {
    Open,
    /// The folder holds the project's data; whether it opens shows when it is opened.
    Available,
    /// The folder, or the project's data in it, is gone.
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ProjectEntry.ts"))]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    /// Last known folder, as Windows shows it.
    pub folder: String,
    /// UTC in ISO 8601; `null` until the project is opened.
    pub last_opened_at: Option<String>,
    pub status: ProjectStatus,
}

/// What the page is shown, and the project behind it.
struct Current {
    view: CurrentProject,
    /// Keeps `project.db` open while the project is the current one.
    open: Option<Project>,
}

impl Current {
    fn open(project: Project) -> Self {
        Self {
            view: CurrentProject::Open {
                project: (&project).into(),
            },
            open: Some(project),
        }
    }

    fn shown(view: CurrentProject) -> Self {
        Self { view, open: None }
    }

    fn none() -> Self {
        Self::shown(CurrentProject::None)
    }

    /// The id of the project shown, open or not.
    fn id(&self) -> Option<&str> {
        match &self.view {
            CurrentProject::None => None,
            CurrentProject::Open { project } => Some(&project.id),
            CurrentProject::Unavailable { id, .. } => Some(id),
        }
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

    fn lock(&self) -> Result<MutexGuard<'_, Option<Current>>, CommandError> {
        self.current.lock().map_err(|_| CommandError::Internal)
    }

    /// The open project; on the first call, the one open at the last run.
    pub fn current(&self) -> Result<CurrentProject, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        Ok(restored(&mut guard, &app)?.view.clone())
    }

    /// Adds the folder as a project and makes it the open one.
    pub fn add(&self, folder: &Path) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let project = projects::add(&app, folder)?;
        let info = ProjectInfo::from(&project);
        *self.lock()? = Some(Current::open(project));
        Ok(info)
    }

    /// All registered projects, the most recently opened first.
    pub fn list(&self) -> Result<Vec<ProjectEntry>, CommandError> {
        let app = self.app()?;
        let open = {
            let mut guard = self.lock()?;
            let current = restored(&mut guard, &app)?;
            current.open.as_ref().map(|project| project.id.clone())
        };
        // The folder checks run without the lock: a slow network drive must not block
        // the other project commands.
        Ok(projects::list(&app)?
            .into_iter()
            .map(|entry| ProjectEntry {
                status: if open.as_deref() == Some(entry.id.as_str()) {
                    ProjectStatus::Open
                } else if entry.present {
                    ProjectStatus::Available
                } else {
                    ProjectStatus::Missing
                },
                id: entry.id,
                name: entry.name,
                folder: entry.folder,
                last_opened_at: entry.last_opened_at,
            })
            .collect())
    }

    /// Opens a registered project and makes it the open one. If it fails, the project
    /// open before stays open.
    pub fn open(&self, id: &str) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let project = projects::open(&app, id)?;
        let info = ProjectInfo::from(&project);
        *guard = Some(Current::open(project));
        Ok(info)
    }

    /// Renames a project in its folder and in the registry.
    pub fn rename(&self, id: &str, name: &str) -> Result<(), CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = restored(&mut guard, &app)?;
        match current.open.as_mut().filter(|project| project.id == id) {
            Some(project) => {
                projects::rename(&app, project, name)?;
                current.view = CurrentProject::Open {
                    project: (&*project).into(),
                };
            }
            None => projects::rename(&app, &mut projects::find(&app, id)?, name)?,
        }
        Ok(())
    }

    /// Removes a project from the list; its folder is not touched. The project closes
    /// if it is the open one.
    pub fn remove(&self, id: &str) -> Result<(), CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = restored(&mut guard, &app)?;
        projects::remove(&app, id)?;
        if current.id() == Some(id) {
            *current = Current::none();
        }
        Ok(())
    }

    /// Points a moved project at the chosen folder and makes it the open one.
    pub fn locate(&self, id: &str, folder: &Path) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let project = projects::locate(&app, id, folder)?;
        let info = ProjectInfo::from(&project);
        *guard = Some(Current::open(project));
        Ok(info)
    }
}

/// The current project; on the first call, the one open at the last run is reopened.
fn restored<'a>(
    current: &'a mut Option<Current>,
    app: &rusqlite::Connection,
) -> Result<&'a mut Current, CommandError> {
    if current.is_none() {
        *current = Some(restore(app)?);
    }
    current.as_mut().ok_or(CommandError::Internal)
}

fn restore(app: &rusqlite::Connection) -> Result<Current, CommandError> {
    let Some((id, name)) = projects::last_opened(app)? else {
        return Ok(Current::none());
    };
    Ok(match projects::open(app, &id) {
        Ok(project) => Current::open(project),
        Err(error) => Current::shown(CurrentProject::Unavailable {
            id,
            name,
            error: error.into(),
        }),
    })
}

/// Ids come from the page; anything that is not a project id names no project.
pub(crate) fn checked(id: &str) -> Result<&str, CommandError> {
    if projects::is_project_id(id) {
        Ok(id)
    } else {
        Err(CommandError::NotFound)
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

#[tauri::command]
pub async fn list_projects(
    workspace: State<'_, Workspace>,
) -> Result<Vec<ProjectEntry>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.list()).await
}

#[tauri::command]
pub async fn open_project(
    id: String,
    workspace: State<'_, Workspace>,
) -> Result<ProjectInfo, CommandError> {
    checked(&id)?;
    let workspace = workspace.inner().clone();
    blocking(move || workspace.open(&id)).await
}

#[tauri::command]
pub async fn rename_project(
    id: String,
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<(), CommandError> {
    checked(&id)?;
    let workspace = workspace.inner().clone();
    blocking(move || workspace.rename(&id, &name)).await
}

#[tauri::command]
pub async fn remove_project(
    id: String,
    workspace: State<'_, Workspace>,
) -> Result<(), CommandError> {
    checked(&id)?;
    let workspace = workspace.inner().clone();
    blocking(move || workspace.remove(&id)).await
}

/// Shows the folder dialog to find a moved project. `None` when the user cancels.
#[tauri::command]
pub async fn locate_project(
    id: String,
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
) -> Result<Option<ProjectInfo>, CommandError> {
    checked(&id)?;
    let Some(folder) = choose_folder(window).await? else {
        return Ok(None);
    };
    let workspace = workspace.inner().clone();
    blocking(move || workspace.locate(&id, &folder))
        .await
        .map(Some)
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
