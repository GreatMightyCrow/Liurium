//! Creating, renaming, moving, and trashing notes and folders (M3-004). Names and
//! paths from the page are checked in Rust by the tree rules; nothing is replaced,
//! nothing is removed for good, links are never touched. The open note is saved
//! first and follows a rename or move. After each action the project is walked
//! again, so the tree shows what is on disk.

use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::organize::{
    entry_path, folder_name, folder_path, is_note_name, join, note_name,
};
use crate::storage::fs::{Expect, ProjectRoot, RelPath};

impl Workspace {
    /// The open project's id and folder, refusing a write-protected project.
    fn writable_project(&self) -> Result<(String, ProjectRoot), CommandError> {
        let (id, root, read_only) = self.open_project_root()?.ok_or(CommandError::NoProject)?;
        if read_only {
            return Err(CommandError::ReadOnly);
        }
        Ok((id, root))
    }

    /// Walks the project again so the tree shows the change.
    fn walk_again(&self, id: String, root: &ProjectRoot) {
        if let Ok(dir) = self.app_dir() {
            self.note_index().start(dir.to_path_buf(), id, root.clone());
        }
    }

    pub fn create_note(&self, folder: &str, name: &str) -> Result<String, CommandError> {
        let (id, root) = self.writable_project()?;
        let folder = folder_path(folder)?;
        let path = join(folder.as_ref(), &note_name(name)?)?;
        root.write(&path, b"", Expect::New)?;
        self.walk_again(id, &root);
        Ok(path.to_string())
    }

    pub fn create_folder(&self, parent: &str, name: &str) -> Result<String, CommandError> {
        let (id, root) = self.writable_project()?;
        let parent = folder_path(parent)?;
        let path = join(parent.as_ref(), &folder_name(name)?)?;
        root.create_folder(&path)?;
        self.walk_again(id, &root);
        Ok(path.to_string())
    }

    pub fn rename_entry(&self, path: &str, name: &str) -> Result<String, CommandError> {
        let (_, root) = self.writable_project()?;
        let from = entry_path(path)?;
        let name = match kind(&root, &from)? {
            Kind::Folder => folder_name(name)?,
            Kind::Note => note_name(name)?,
        };
        self.relocate(&root, from.clone(), join(from.parent().as_ref(), &name)?)
    }

    pub fn move_entry(&self, path: &str, folder: &str) -> Result<String, CommandError> {
        let (_, root) = self.writable_project()?;
        let from = entry_path(path)?;
        let folder = folder_path(folder)?;
        kind(&root, &from)?;
        self.relocate(
            &root,
            from.clone(),
            join(folder.as_ref(), from.file_name())?,
        )
    }

    pub fn trash_entry(&self, path: &str) -> Result<(), CommandError> {
        let (id, root) = self.writable_project()?;
        let path = entry_path(path)?;
        kind(&root, &path)?;
        self.editor().save_if_under(&path)?;
        root.trash(&path)?;
        self.editor().trashed(&path);
        self.walk_again(id, &root);
        Ok(())
    }

    /// Renames or moves, with the open note saved first and following after.
    fn relocate(
        &self,
        root: &ProjectRoot,
        from: RelPath,
        to: RelPath,
    ) -> Result<String, CommandError> {
        if from == to {
            return Ok(to.to_string());
        }
        self.editor().save_if_under(&from)?;
        root.rename(&from, &to)?;
        self.editor().moved(&from, &to);
        // The move is done. If the links cannot follow, they show as missing notes
        // and no task is lost (M4-003).
        let _ = self.with_open_project(|project| {
            Ok(project.notes_moved(&from.to_string(), &to.to_string())?)
        });
        if let Some((id, _, _)) = self.open_project_root()? {
            self.walk_again(id, root);
        }
        Ok(to.to_string())
    }
}

enum Kind {
    Note,
    Folder,
}

/// Only notes and folders of the tree are renamed, moved, or trashed; any other
/// file (code, images) is refused.
fn kind(root: &ProjectRoot, path: &RelPath) -> Result<Kind, CommandError> {
    if root.is_folder(path)? {
        Ok(Kind::Folder)
    } else if is_note_name(path.file_name()) {
        Ok(Kind::Note)
    } else {
        Err(CommandError::InvalidPath)
    }
}

#[tauri::command]
pub async fn create_note(
    folder: String,
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<String, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.create_note(&folder, &name)).await
}

#[tauri::command]
pub async fn create_folder(
    parent: String,
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<String, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.create_folder(&parent, &name)).await
}

#[tauri::command]
pub async fn rename_entry(
    path: String,
    name: String,
    workspace: State<'_, Workspace>,
) -> Result<String, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.rename_entry(&path, &name)).await
}

#[tauri::command]
pub async fn move_entry(
    path: String,
    folder: String,
    workspace: State<'_, Workspace>,
) -> Result<String, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.move_entry(&path, &folder)).await
}

#[tauri::command]
pub async fn trash_entry(
    path: String,
    workspace: State<'_, Workspace>,
) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.trash_entry(&path)).await
}
