//! The note open in the editor (M3-003). The page names a note by its path below the
//! open project; Rust checks it by the note rules, keeps the latest text as a draft,
//! and writes only over the file as it last read or wrote it. Closing the window
//! saves the draft first (`window.rs`).

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{
    session::{Choice, MAX_NOTE_BYTES, NoteError, ReadOnly, Resolved, Saved, Session, note_path},
    text::LineEnding,
};
use crate::storage::fs::{FsError, ProjectRoot, RelPath};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "OpenedNote.ts"))]
pub struct OpenedNote {
    /// Below the project folder, parts joined with `/`.
    pub path: String,
    /// The draft if there is one, else the file; with the file's line endings.
    pub text: String,
    pub line_ending: NoteLineEnding,
    /// Why the note cannot be edited; `null` when it can.
    pub read_only: Option<NoteReadOnly>,
    /// The text is newer than the file.
    pub unsaved: bool,
    /// The file changed outside Liurium; saving waits for a choice.
    pub conflict: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteLineEnding.ts"))]
pub enum NoteLineEnding {
    Crlf,
    Lf,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteReadOnly.ts"))]
pub enum NoteReadOnly {
    Project,
    File,
    /// Mixed line endings; `open_note` with `unify` makes them one.
    LineEndings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SaveState.ts"))]
pub enum SaveState {
    Saved,
    /// Kept by Rust, written later.
    Draft,
    /// The file changed outside Liurium; `resolve_note_conflict` decides.
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ConflictChoice.ts"))]
pub enum ConflictChoice {
    Reload,
    Overwrite,
    KeepBoth,
}

impl OpenedNote {
    fn of(session: &Session) -> Self {
        Self {
            path: session.path().to_string(),
            text: session.text().to_owned(),
            line_ending: match session.ending() {
                LineEnding::Crlf => NoteLineEnding::Crlf,
                LineEnding::Lf => NoteLineEnding::Lf,
                LineEnding::Mixed => NoteLineEnding::Mixed,
            },
            read_only: session.read_only().map(|reason| match reason {
                ReadOnly::Project => NoteReadOnly::Project,
                ReadOnly::File => NoteReadOnly::File,
                ReadOnly::LineEndings => NoteReadOnly::LineEndings,
            }),
            unsaved: session.has_draft(),
            conflict: session.in_conflict(),
        }
    }
}

impl From<NoteError> for CommandError {
    fn from(error: NoteError) -> Self {
        match error {
            NoteError::Fs(error) => error.into(),
            NoteError::NotUtf8 => Self::NotUtf8,
            NoteError::ReadOnly => Self::ReadOnly,
            NoteError::NotOpen => Self::NotFound,
        }
    }
}

/// The open note and the project folder it belongs to.
struct Slot {
    project_id: String,
    root: ProjectRoot,
    project_read_only: bool,
    session: Session,
}

/// What an organize action (M3-004) does to the open note.
impl Editor {
    /// Saves the open note if `affected` is it or a folder above it. An unsolved
    /// conflict refuses the action, so no draft is lost.
    pub fn save_if_under(&self, affected: &RelPath) -> Result<(), CommandError> {
        let mut slot = self.lock()?;
        let Some(open) = slot.as_mut() else {
            return Ok(());
        };
        if !open.session.path().starts_with(affected) {
            return Ok(());
        }
        if open.session.in_conflict() {
            return Err(CommandError::Unsaved);
        }
        match open.session.save(&open.root)? {
            Saved::Saved => Ok(()),
            Saved::Conflict | Saved::Draft => Err(CommandError::Unsaved),
        }
    }

    /// The open note follows a rename or move.
    pub fn moved(&self, from: &RelPath, to: &RelPath) {
        if let Ok(mut slot) = self.slot.lock()
            && let Some(open) = slot.as_mut()
        {
            open.session.rebase(from, to);
        }
    }

    /// The open note, or a folder above it, went to the trash: the editor closes.
    pub fn trashed(&self, path: &RelPath) {
        if let Ok(mut slot) = self.slot.lock()
            && slot
                .as_ref()
                .is_some_and(|open| open.session.path().starts_with(path))
        {
            *slot = None;
        }
    }
}

/// What a close found (`window.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseCheck {
    /// Nothing unsaved, or saved now.
    Clear,
    /// The draft could not be written; the user decides.
    Unsaved { name: String, conflict: bool },
}

#[derive(Clone, Default)]
pub struct Editor {
    slot: Arc<Mutex<Option<Slot>>>,
    /// Notes saved since the cache last read their links (M3-006); refreshed before
    /// backlinks are computed.
    saved: Arc<Mutex<Vec<RelPath>>>,
}

impl Editor {
    fn mark(&self, path: &RelPath) {
        if let Ok(mut saved) = self.saved.lock()
            && !saved.contains(path)
        {
            saved.push(path.clone());
        }
    }

    /// The notes saved since the last call.
    pub fn take_saved(&self) -> Vec<RelPath> {
        self.saved
            .lock()
            .map(|mut saved| std::mem::take(&mut *saved))
            .unwrap_or_default()
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Slot>>, CommandError> {
        self.slot.lock().map_err(|_| CommandError::Internal)
    }

    /// Saves the open note before another project opens; a conflict keeps both.
    /// If saving fails, the note stays open with its draft, so nothing is lost.
    pub fn leave_project(&self) {
        let Ok(mut slot) = self.slot.lock() else {
            return;
        };
        let flushed = match slot.as_mut() {
            Some(open) => open.session.flush(&open.root).is_ok(),
            None => true,
        };
        if flushed {
            *slot = None;
        }
        // The next walk of another project reads its own changed notes.
        drop(self.take_saved());
    }

    /// Tries to save before the window closes.
    pub fn save_before_close(&self) -> CloseCheck {
        let Ok(mut slot) = self.slot.lock() else {
            return CloseCheck::Clear;
        };
        let Some(open) = slot.as_mut() else {
            return CloseCheck::Clear;
        };
        if !open.session.has_draft() {
            return CloseCheck::Clear;
        }
        let name = open
            .session
            .path()
            .parts()
            .last()
            .unwrap_or_default()
            .to_owned();
        match open.session.save(&open.root) {
            Ok(Saved::Saved) => CloseCheck::Clear,
            Ok(Saved::Conflict) => CloseCheck::Unsaved {
                name,
                conflict: true,
            },
            Ok(Saved::Draft) | Err(_) => CloseCheck::Unsaved {
                name,
                conflict: false,
            },
        }
    }

    /// The user chose "keep both" while closing. Returns whether it was written.
    pub fn keep_both_before_close(&self) -> bool {
        let Ok(mut slot) = self.slot.lock() else {
            return false;
        };
        let Some(open) = slot.as_mut() else {
            return true;
        };
        let read_only = open.project_read_only;
        open.session
            .resolve(&open.root, Choice::KeepBoth, read_only)
            .is_ok()
    }

    /// The user chose to close without saving.
    pub fn discard(&self) {
        if let Ok(mut slot) = self.slot.lock()
            && let Some(open) = slot.as_mut()
        {
            open.session.discard();
        }
    }
}

impl Workspace {
    pub fn open_note(&self, path: &str, unify: bool) -> Result<OpenedNote, CommandError> {
        let path = note_path(path)?;
        let (project_id, root, project_read_only) =
            self.open_project_root()?.ok_or(CommandError::NoProject)?;
        let mut slot = self.editor().lock()?;
        if let Some(open) = slot.as_mut() {
            let same = open.project_id == project_id && open.session.is(&path);
            if same && !unify {
                return Ok(OpenedNote::of(&open.session));
            }
            // Leaving a note saves it; a conflict keeps both.
            let left = open.session.path().clone();
            open.session.flush(&open.root)?;
            self.editor().mark(&left);
            self.editor().mark(open.session.path());
        }
        let session = Session::open(&root, path, project_read_only, unify)?;
        let opened = OpenedNote::of(&session);
        *slot = Some(Slot {
            project_id,
            root,
            project_read_only,
            session,
        });
        Ok(opened)
    }

    pub fn update_note(
        &self,
        path: &str,
        text: &str,
        save: bool,
    ) -> Result<SaveState, CommandError> {
        let limit = usize::try_from(MAX_NOTE_BYTES.saturating_mul(2)).unwrap_or(usize::MAX);
        if text.len() > limit {
            return Err(FsError::TooLarge {
                len: u64::try_from(text.len()).unwrap_or(u64::MAX),
                max: MAX_NOTE_BYTES,
            }
            .into());
        }
        self.with_open(path, |open, editor| {
            Ok(match open.session.update(&open.root, text, save)? {
                Saved::Saved => {
                    editor.mark(open.session.path());
                    SaveState::Saved
                }
                Saved::Draft => SaveState::Draft,
                Saved::Conflict => SaveState::Conflict,
            })
        })
    }

    pub fn resolve_note_conflict(
        &self,
        path: &str,
        choice: ConflictChoice,
    ) -> Result<OpenedNote, CommandError> {
        self.with_open(path, |open, editor| {
            let choice = match choice {
                ConflictChoice::Reload => Choice::Reload,
                ConflictChoice::Overwrite => Choice::Overwrite,
                ConflictChoice::KeepBoth => Choice::KeepBoth,
            };
            let _: Resolved = open
                .session
                .resolve(&open.root, choice, open.project_read_only)?;
            editor.mark(open.session.path());
            Ok(OpenedNote::of(&open.session))
        })
    }

    /// Leaves the note; refused while its text is not saved.
    pub fn close_note(&self, path: &str) -> Result<(), CommandError> {
        let path = note_path(path)?;
        let mut slot = self.editor().lock()?;
        match slot.as_ref() {
            Some(open) if open.session.is(&path) => {
                if open.session.has_draft() || open.session.in_conflict() {
                    return Err(CommandError::Unsaved);
                }
                *slot = None;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn with_open<T>(
        &self,
        path: &str,
        work: impl FnOnce(&mut Slot, &Editor) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let path = note_path(path)?;
        let mut slot = self.editor().lock()?;
        match slot.as_mut() {
            Some(open) if open.session.is(&path) => work(open, self.editor()),
            _ => Err(NoteError::NotOpen.into()),
        }
    }
}

#[tauri::command]
pub async fn open_note(
    path: String,
    unify: bool,
    workspace: State<'_, Workspace>,
) -> Result<OpenedNote, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.open_note(&path, unify)).await
}

#[tauri::command]
pub async fn update_note(
    path: String,
    text: String,
    save: bool,
    workspace: State<'_, Workspace>,
) -> Result<SaveState, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.update_note(&path, &text, save)).await
}

#[tauri::command]
pub async fn resolve_note_conflict(
    path: String,
    choice: ConflictChoice,
    workspace: State<'_, Workspace>,
) -> Result<OpenedNote, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.resolve_note_conflict(&path, choice)).await
}

#[tauri::command]
pub async fn close_note(path: String, workspace: State<'_, Workspace>) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.close_note(&path)).await
}
