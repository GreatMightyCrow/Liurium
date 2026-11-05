//! Projects: add, open, list, rename, remove, locate (M2-005, M2-006), separate a copy
//! (M2-011). The page never sends a path: folders come from the native dialog that Rust
//! shows, and projects are named by their id.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Serialize;
use tauri::{State, WebviewWindow};

use super::{CommandError, DataStatus, editor::Editor, notes::NoteIndex};
use crate::domain::{
    projects::{self, Project, ProjectCopy, ProjectError},
    settings::StartWith,
    sync::{self, SyncRoot, SyncTool},
};
use crate::storage::{
    db::{self, APP_DB, Kind, OpenMode},
    fs::ProjectRoot,
};

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
    /// The sync tool whose folder holds the project, the first time it is opened there
    /// (M2-010); `null` otherwise.
    pub synced_by: Option<SyncTool>,
}

impl ProjectInfo {
    fn new(project: &Project, synced_by: Option<SyncTool>) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            folder: project.root.display(),
            read_only: project.read_only,
            synced_by,
        }
    }
}

/// What adding a folder gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "AddOutcome.ts"))]
pub enum AddOutcome {
    /// The folder is a project now, and the open one.
    Added { project: ProjectInfo },
    /// The folder holds the same project as a registered folder that still holds it.
    /// Nothing was written; `separate_project_copy` gives it its own identity (M2-011).
    Copy {
        /// The folder that was added, as Windows shows it.
        folder: String,
        original_name: String,
        original_folder: String,
    },
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
    fn open(project: Project, info: ProjectInfo) -> Self {
        Self {
            view: CurrentProject::Open { project: info },
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
    /// Folders of sync tools, found at start.
    sync_roots: Arc<[SyncRoot]>,
    /// The copy found by the last add, until the user answers (M2-011). Kept here
    /// because the page never sends a path.
    copy: Arc<Mutex<Option<ProjectCopy>>>,
    /// The startup setting read at start (M3-009): whether the last project reopens.
    start_with: StartWith,
    /// The background walk of the open project's notes (M3-002).
    notes: NoteIndex,
    /// The note open in the editor (M3-003).
    editor: Editor,
}

impl Workspace {
    /// Without a usable `app.db` (see `Startup`), every project command reports why.
    pub fn new(
        app_dir: Option<PathBuf>,
        data: &DataStatus,
        sync_roots: Vec<SyncRoot>,
        start_with: StartWith,
    ) -> Self {
        let app_dir = match (app_dir, data) {
            (_, DataStatus::Failed { error }) => Err(error.clone()),
            (None, _) => Err(CommandError::Internal),
            (Some(dir), _) => Ok(dir),
        };
        Self {
            app_dir,
            current: Arc::new(Mutex::new(None)),
            sync_roots: sync_roots.into(),
            copy: Arc::new(Mutex::new(None)),
            start_with,
            notes: NoteIndex::default(),
            editor: Editor::default(),
        }
    }

    pub(super) fn app_dir(&self) -> Result<&Path, CommandError> {
        self.app_dir.as_deref().map_err(|error| error.clone())
    }

    pub(super) fn app(&self) -> Result<rusqlite::Connection, CommandError> {
        Ok(db::open(
            &self.app_dir()?.join(APP_DB),
            Kind::App,
            OpenMode::Existing,
        )?)
    }

    pub(super) fn note_index(&self) -> &NoteIndex {
        &self.notes
    }

    pub fn editor(&self) -> &Editor {
        &self.editor
    }

    /// Id, folder, and write protection of the open project.
    pub(super) fn open_project_root(
        &self,
    ) -> Result<Option<(String, ProjectRoot, bool)>, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = self.restored(&mut guard, &app)?;
        Ok(current
            .open
            .as_ref()
            .map(|project| (project.id.clone(), project.root.clone(), project.read_only)))
    }

    /// Works with the open project, reopening the last one on the first call.
    pub(super) fn with_open_project<T>(
        &self,
        work: impl FnOnce(&Project) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = self.restored(&mut guard, &app)?;
        work(current.open.as_ref().ok_or(CommandError::NoProject)?)
    }

    /// Id and folder of the open project, reopening the last one on the first call.
    pub(super) fn open_root(&self) -> Result<Option<(String, ProjectRoot)>, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = self.restored(&mut guard, &app)?;
        Ok(current
            .open
            .as_ref()
            .map(|project| (project.id.clone(), project.root.clone())))
    }

    /// Makes a project the open one and starts walking its notes. The note open in
    /// the editor is saved first.
    fn opened(&self, project: Project, info: ProjectInfo) -> Current {
        self.editor.leave_project();
        if let Ok(dir) = self.app_dir() {
            self.notes
                .start(dir.to_path_buf(), project.id.clone(), project.root.clone());
        }
        Current::open(project, info)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Current>>, CommandError> {
        self.current.lock().map_err(|_| CommandError::Internal)
    }

    fn copy(&self) -> Result<MutexGuard<'_, Option<ProjectCopy>>, CommandError> {
        self.copy.lock().map_err(|_| CommandError::Internal)
    }

    /// The open project; on the first call, the one open at the last run.
    pub fn current(&self) -> Result<CurrentProject, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        Ok(self.restored(&mut guard, &app)?.view.clone())
    }

    /// Adds the folder as a project and makes it the open one. A copy of a registered
    /// project is kept for the user's answer instead; the open project stays open.
    pub fn add(&self, folder: &Path) -> Result<AddOutcome, CommandError> {
        let app = self.app()?;
        // A new add replaces an unanswered question.
        *self.copy()? = None;
        let project = match projects::add(&app, folder) {
            Ok(project) => project,
            Err(ProjectError::Duplicate(copy)) => {
                let outcome = AddOutcome::Copy {
                    folder: copy.display.clone(),
                    original_name: copy.original_name.clone(),
                    original_folder: copy.original_folder.clone(),
                };
                *self.copy()? = Some(*copy);
                return Ok(outcome);
            }
            Err(error) => return Err(error.into()),
        };
        let info = self.info(&app, &project);
        *self.lock()? = Some(self.opened(project, info.clone()));
        Ok(AddOutcome::Added { project: info })
    }

    /// Gives the copy found by the last add its own identity and makes it the open
    /// project. The question is answered once, whatever the result.
    pub fn separate_copy(&self) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let copy = self.copy()?.take().ok_or(CommandError::NotFound)?;
        let mut guard = self.lock()?;
        let project = projects::separate(&app, &copy)?;
        let info = self.info(&app, &project);
        *guard = Some(self.opened(project, info.clone()));
        Ok(info)
    }

    /// All registered projects, the most recently opened first.
    pub fn list(&self) -> Result<Vec<ProjectEntry>, CommandError> {
        let app = self.app()?;
        let open = {
            let mut guard = self.lock()?;
            let current = self.restored(&mut guard, &app)?;
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
        let info = self.info(&app, &project);
        *guard = Some(self.opened(project, info.clone()));
        Ok(info)
    }

    /// Renames a project in its folder and in the registry.
    pub fn rename(&self, id: &str, name: &str) -> Result<(), CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let current = self.restored(&mut guard, &app)?;
        match current.open.as_mut().filter(|project| project.id == id) {
            Some(project) => {
                projects::rename(&app, project, name)?;
                if let CurrentProject::Open { project: info } = &mut current.view {
                    info.name.clone_from(&project.name);
                }
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
        let current = self.restored(&mut guard, &app)?;
        projects::remove(&app, id)?;
        if current.id() == Some(id) {
            *current = Current::none();
            self.notes.clear();
            self.editor.leave_project();
        }
        Ok(())
    }

    /// Points a moved project at the chosen folder and makes it the open one.
    pub fn locate(&self, id: &str, folder: &Path) -> Result<ProjectInfo, CommandError> {
        let app = self.app()?;
        let mut guard = self.lock()?;
        let project = projects::locate(&app, id, folder)?;
        let info = self.info(&app, &project);
        *guard = Some(self.opened(project, info.clone()));
        Ok(info)
    }

    /// What the page is shown about a project just opened, with the sync-folder
    /// warning the first time the project is opened inside a sync folder.
    fn info(&self, app: &rusqlite::Connection, project: &Project) -> ProjectInfo {
        let synced_by = sync::tool_for(project.root.path(), &self.sync_roots).filter(|_| {
            // If the registry cannot record it, the warning shows again next time
            // rather than never.
            projects::first_sync_warning(app, &project.id).unwrap_or(true)
        });
        ProjectInfo::new(project, synced_by)
    }

    /// The current project; on the first call, the one open at the last run is
    /// reopened.
    fn restored<'a>(
        &self,
        current: &'a mut Option<Current>,
        app: &rusqlite::Connection,
    ) -> Result<&'a mut Current, CommandError> {
        if current.is_none() {
            *current = Some(self.restore(app)?);
        }
        current.as_mut().ok_or(CommandError::Internal)
    }

    fn restore(&self, app: &rusqlite::Connection) -> Result<Current, CommandError> {
        if self.start_with == StartWith::ProjectList {
            return Ok(Current::none());
        }
        let Some((id, name)) = projects::last_opened(app)? else {
            return Ok(Current::none());
        };
        Ok(match projects::open(app, &id) {
            Ok(project) => {
                let info = self.info(app, &project);
                self.opened(project, info)
            }
            Err(error) => Current::shown(CurrentProject::Unavailable {
                id,
                name,
                error: error.into(),
            }),
        })
    }
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
pub(super) async fn blocking<T: Send + 'static>(
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
) -> Result<Option<AddOutcome>, CommandError> {
    let Some(folder) = choose_folder(window).await? else {
        return Ok(None);
    };
    let workspace = workspace.inner().clone();
    blocking(move || workspace.add(&folder)).await.map(Some)
}

/// The user agreed to make the copy found by the last add a separate project. Takes no
/// path: only that folder can be changed, and only its `project.db`.
#[tauri::command]
pub async fn separate_project_copy(
    workspace: State<'_, Workspace>,
) -> Result<ProjectInfo, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.separate_copy()).await
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
