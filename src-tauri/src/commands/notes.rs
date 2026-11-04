//! The notes of the open project (M3-002). Rust walks the project in the background
//! as soon as it opens; `list_notes` waits for that walk and returns what the cache
//! holds. The page sends nothing and gets only paths below the open project, no
//! content.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
};

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{self, Index};
use crate::storage::fs::{Limits, ProjectRoot, Skipped};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteEntry.ts"))]
pub struct NoteEntry {
    /// Below the project folder, parts joined with `/`.
    pub path: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
    /// Milliseconds since 1970-01-01 UTC.
    #[cfg_attr(test, ts(type = "number"))]
    pub modified_ms: i64,
}

/// What the walk passed over, by reason; counts only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SkippedNotes.ts"))]
pub struct SkippedNotes {
    /// Links that lead outside the project or into `.liurium` or `.git`.
    pub links_outside: usize,
    pub broken_links: usize,
    /// Names that are not valid Unicode or that Windows rules refuse.
    pub bad_names: usize,
    pub unreadable: usize,
    /// Folders deeper than the depth limit.
    pub too_deep: usize,
    pub depth_limit: usize,
}

impl SkippedNotes {
    fn new(skipped: Skipped) -> Self {
        Self {
            links_outside: skipped.links_outside,
            broken_links: skipped.broken_links,
            bad_names: skipped.bad_names,
            unreadable: skipped.unreadable,
            too_deep: skipped.too_deep,
            depth_limit: Limits::DEFAULT.depth,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NotesView.ts"))]
pub enum NotesView {
    /// No project is open.
    NoProject,
    Ready {
        notes: Vec<NoteEntry>,
        skipped: SkippedNotes,
        /// The project holds more notes than the limit; only that many are listed.
        truncated: bool,
        note_limit: usize,
        /// Folders with nothing in them, so a new folder shows in the tree (M3-004).
        empty_folders: Vec<String>,
    },
}

impl NotesView {
    fn of(index: Index) -> Self {
        Self::Ready {
            notes: index
                .notes
                .into_iter()
                .map(|note| NoteEntry {
                    path: note.path,
                    size: note.size,
                    modified_ms: note.modified_ns.div_euclid(1_000_000),
                })
                .collect(),
            skipped: SkippedNotes::new(index.skipped),
            truncated: index.truncated,
            note_limit: Limits::DEFAULT.notes,
            empty_folders: index.empty_folders,
        }
    }
}

/// The walk of the open project. Only the newest walk counts: opening another
/// project makes an older walk's result count for nothing.
#[derive(Clone, Default)]
pub struct NoteIndex {
    shared: Arc<(Mutex<Slot>, Condvar)>,
}

#[derive(Default)]
struct Slot {
    generation: u64,
    project: Option<String>,
    result: Option<Result<NotesView, CommandError>>,
}

impl NoteIndex {
    /// Starts walking a project on its own thread.
    pub fn start(&self, app_dir: PathBuf, project_id: String, root: ProjectRoot) {
        let (lock, _) = &*self.shared;
        let Ok(mut slot) = lock.lock() else {
            return;
        };
        slot.generation += 1;
        slot.project = Some(project_id.clone());
        slot.result = None;
        let generation = slot.generation;
        drop(slot);

        let shared = Arc::clone(&self.shared);
        std::thread::spawn(move || {
            // A panic must not leave `wait` waiting forever.
            let result = catch_unwind(AssertUnwindSafe(|| {
                notes::refresh(&app_dir, &project_id, &root)
                    .map(NotesView::of)
                    .map_err(CommandError::from)
            }))
            .unwrap_or(Err(CommandError::Internal));
            let (lock, ready) = &*shared;
            if let Ok(mut slot) = lock.lock()
                && slot.generation == generation
            {
                slot.result = Some(result);
            }
            ready.notify_all();
        });
    }

    /// Starts a walk unless one for this project is running or done.
    pub fn ensure(&self, app_dir: PathBuf, project_id: &str, root: &ProjectRoot) {
        let started = {
            let (lock, _) = &*self.shared;
            lock.lock()
                .is_ok_and(|slot| slot.project.as_deref() == Some(project_id))
        };
        if !started {
            self.start(app_dir, project_id.to_owned(), root.clone());
        }
    }

    /// No project is open any more.
    pub fn clear(&self) {
        let (lock, ready) = &*self.shared;
        if let Ok(mut slot) = lock.lock() {
            slot.generation += 1;
            slot.project = None;
            slot.result = None;
        }
        ready.notify_all();
    }

    /// The result for this project once its walk is done; `None` when another
    /// project took its place meanwhile.
    pub fn wait(&self, project_id: &str) -> Option<Result<NotesView, CommandError>> {
        let (lock, ready) = &*self.shared;
        let mut slot = lock.lock().ok()?;
        loop {
            if slot.project.as_deref() != Some(project_id) {
                return None;
            }
            if let Some(result) = &slot.result {
                return Some(result.clone());
            }
            slot = ready.wait(slot).ok()?;
        }
    }
}

impl Workspace {
    /// The notes of the open project, after its walk.
    pub fn notes(&self) -> Result<NotesView, CommandError> {
        // A project opened while waiting replaces the one asked for; ask again.
        for _ in 0..3 {
            let Some((id, root)) = self.open_root()? else {
                return Ok(NotesView::NoProject);
            };
            self.note_index()
                .ensure(self.app_dir()?.to_path_buf(), &id, &root);
            if let Some(result) = self.note_index().wait(&id) {
                return result;
            }
        }
        Err(CommandError::Internal)
    }
}

#[tauri::command]
pub async fn list_notes(workspace: State<'_, Workspace>) -> Result<NotesView, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.notes()).await
}
