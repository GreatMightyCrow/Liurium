//! Tasks and columns of the open project (M4-003). Ids and fields from the page are
//! checked in `domain::projects::tasks`; a write-protected project refuses every change.

use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::projects::{
    Project,
    tasks::{Board, Task, TaskDetail, TaskError, TaskFields},
};

impl Workspace {
    fn read_tasks<T>(
        &self,
        work: impl FnOnce(&Project) -> Result<T, TaskError>,
    ) -> Result<T, CommandError> {
        self.with_open_project(|project| Ok(work(project)?))
    }

    fn change_tasks<T>(
        &self,
        work: impl FnOnce(&Project) -> Result<T, TaskError>,
    ) -> Result<T, CommandError> {
        self.with_open_project(|project| {
            if project.read_only {
                return Err(CommandError::ReadOnly);
            }
            Ok(work(project)?)
        })
    }

    pub fn task_board(&self) -> Result<Board, CommandError> {
        self.read_tasks(Project::task_board)
    }

    pub fn trashed_tasks(&self) -> Result<Vec<Task>, CommandError> {
        self.read_tasks(Project::trashed_tasks)
    }

    pub fn task_detail(&self, task: &str) -> Result<TaskDetail, CommandError> {
        self.read_tasks(|project| project.task_detail(task))
    }

    pub fn create_task(&self, column: &str, fields: TaskFields) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.create_task(column, fields))
    }

    pub fn update_task(&self, task: &str, fields: TaskFields) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.update_task(task, fields))
    }

    pub fn move_task(&self, task: &str, column: &str, index: u32) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.move_task(task, column, index))
    }

    pub fn trash_task(&self, task: &str) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.trash_task(task))
    }

    pub fn restore_task(&self, task: &str) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.restore_task(task))
    }

    pub fn delete_task(&self, task: &str) -> Result<(), CommandError> {
        self.change_tasks(|project| project.delete_task(task))
    }

    pub fn create_column(&self, name: &str) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.create_column(name))
    }

    pub fn rename_column(&self, column: &str, name: &str) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.rename_column(column, name))
    }

    pub fn move_column(&self, column: &str, index: u32) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.move_column(column, index))
    }

    pub fn delete_column(&self, column: &str) -> Result<Board, CommandError> {
        self.change_tasks(|project| project.delete_column(column))
    }
}

#[tauri::command]
pub async fn task_board(workspace: State<'_, Workspace>) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.task_board()).await
}

#[tauri::command]
pub async fn trashed_tasks(workspace: State<'_, Workspace>) -> Result<Vec<Task>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.trashed_tasks()).await
}

#[tauri::command]
pub async fn task_detail(
    task: String,
    workspace: State<'_, Workspace>,
) -> Result<TaskDetail, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.task_detail(&task)).await
}

#[tauri::command]
pub async fn create_task(
    column: String,
    fields: TaskFields,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.create_task(&column, fields)).await
}

#[tauri::command]
pub async fn update_task(
    task: String,
    fields: TaskFields,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.update_task(&task, fields)).await
}

#[tauri::command]
pub async fn move_task(
    task: String,
    column: String,
    index: u32,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.move_task(&task, &column, index)).await
}

#[tauri::command]
pub async fn trash_task(
    task: String,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.trash_task(&task)).await
}

#[tauri::command]
pub async fn restore_task(
    task: String,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.restore_task(&task)).await
}

#[tauri::command]
pub async fn delete_task(
    task: String,
    workspace: State<'_, Workspace>,
) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.delete_task(&task)).await
}

#[tauri::command]
pub async fn create_column(
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.create_column(&name)).await
}

#[tauri::command]
pub async fn rename_column(
    column: String,
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.rename_column(&column, &name)).await
}

#[tauri::command]
pub async fn move_column(
    column: String,
    index: u32,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.move_column(&column, index)).await
}

#[tauri::command]
pub async fn delete_column(
    column: String,
    workspace: State<'_, Workspace>,
) -> Result<Board, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.delete_column(&column)).await
}
