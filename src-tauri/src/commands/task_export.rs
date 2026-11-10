//! Exporting the open project's tasks to one Markdown file (M4-009). The page never
//! names a path: it asks for the proposed file in the project, or for the Windows save
//! dialog, whose answer stays in Rust.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{State, WebviewWindow};

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::organize::entry_path;
use crate::domain::projects::{Project, task_export::EXPORT_NAME, tasks::TaskError};
use crate::storage::fs::{Expect, FsError, write_chosen};

/// As long as the longest export, to compare with what is there.
const MAX_COMPARED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "TaskExport.ts"))]
pub enum TaskExport {
    /// `place` is where to find it, for the user to read.
    Written { place: String },
    /// A different file has the name; nothing was written.
    Exists,
    /// The save dialog was closed.
    Cancelled,
}

fn tasks_markdown(project: &Project) -> Result<String, TaskError> {
    project.tasks_markdown()
}

impl Workspace {
    /// Into the project. A different file of that name is left alone unless `replace`
    /// says so, and then goes to the project's trash.
    pub fn export_tasks(&self, replace: bool) -> Result<TaskExport, CommandError> {
        let (id, root) = self.writable_project()?;
        let text = self.with_open_project(|project| Ok(tasks_markdown(project)?))?;
        let path = entry_path(EXPORT_NAME)?;
        let written = TaskExport::Written {
            place: EXPORT_NAME.to_owned(),
        };
        match root.stamp(&path) {
            Err(FsError::NotFound) => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                let same = match root.read(&path, MAX_COMPARED_BYTES) {
                    Ok((old, _)) => old == text.as_bytes(),
                    Err(FsError::TooLarge { .. }) => false,
                    Err(error) => return Err(error.into()),
                };
                if same {
                    return Ok(written);
                }
                if !replace {
                    return Ok(TaskExport::Exists);
                }
                self.editor().save_if_under(&path)?;
                root.trash(&path)?;
                self.editor().trashed(&path);
            }
        }
        root.write(&path, text.as_bytes(), Expect::New)?;
        self.walk_again(id, &root);
        Ok(written)
    }

    /// To a place picked in the save dialog, which has asked before replacing a file.
    pub fn export_tasks_to(&self, path: &Path) -> Result<TaskExport, CommandError> {
        let is_markdown = path
            .extension()
            .is_some_and(|ending| ending.eq_ignore_ascii_case("md"));
        let folder = path.parent().ok_or(CommandError::InvalidPath)?;
        if !is_markdown {
            return Err(CommandError::InvalidPath);
        }
        let (id, root, read_only) = self.open_project_root()?.ok_or(CommandError::NoProject)?;
        let inside = root.contains(folder)?;
        if inside && read_only {
            return Err(CommandError::ReadOnly);
        }
        if inside && root.protects(folder)? {
            return Err(CommandError::Protected);
        }
        let text = self.with_open_project(|project| Ok(tasks_markdown(project)?))?;
        write_chosen(path, text.as_bytes())?;
        if inside {
            self.walk_again(id, &root);
        }
        Ok(TaskExport::Written {
            place: path.display().to_string(),
        })
    }
}

#[tauri::command]
pub async fn export_tasks(
    replace: bool,
    workspace: State<'_, Workspace>,
) -> Result<TaskExport, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.export_tasks(replace)).await
}

#[tauri::command]
pub async fn export_tasks_elsewhere(
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
) -> Result<TaskExport, CommandError> {
    let Some(path) = choose_place(window).await? else {
        return Ok(TaskExport::Cancelled);
    };
    let workspace = workspace.inner().clone();
    blocking(move || workspace.export_tasks_to(&path)).await
}

#[cfg(not(feature = "e2e"))]
async fn choose_place(window: WebviewWindow) -> Result<Option<PathBuf>, CommandError> {
    blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title("Export tasks")
            .add_filter("Markdown", &["md"])
            .set_file_name(EXPORT_NAME)
            .set_parent(&window)
            .save_file())
    })
    .await
}

#[cfg(feature = "e2e")]
async fn choose_place(_window: WebviewWindow) -> Result<Option<PathBuf>, CommandError> {
    Ok(crate::e2e::picked_file())
}
