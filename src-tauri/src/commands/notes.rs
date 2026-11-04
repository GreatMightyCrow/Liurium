//! The notes of the open project (M3-002). Rust walks the project in the background
//! as soon as it opens; `list_notes` waits for that walk and returns what the cache
//! holds. The page sends nothing and gets only paths below the open project, no
//! content.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, PoisonError},
};

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{self, Index, links::NoteSet};
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
    /// What Liurium writes inside `[[…]]` for this note: its name, or the shortest
    /// unique end of its path (M3-005).
    pub link: String,
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
    fn of(index: Index, set: &NoteSet) -> Self {
        Self::Ready {
            notes: index
                .notes
                .into_iter()
                .map(|note| NoteEntry {
                    link: set.link_text(&note.path),
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
    /// One walk at a time: an older walk that wrote its view of the folder after a
    /// newer one left moved notes in the cache (found by the M3-005 tests).
    walking: Arc<Mutex<()>>,
}

#[derive(Default)]
struct Slot {
    generation: u64,
    project: Option<String>,
    result: Option<Result<NotesView, CommandError>>,
    /// The notes of the last walk, for resolving links (M3-005).
    set: Option<Arc<NoteSet>>,
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
        slot.set = None;
        let generation = slot.generation;
        drop(slot);

        let shared = Arc::clone(&self.shared);
        let walking = Arc::clone(&self.walking);
        std::thread::spawn(move || {
            // A poisoned lock only means an earlier walk panicked; the cache is
            // written in one transaction, so walking on is safe.
            let _one_at_a_time = walking.lock().unwrap_or_else(PoisonError::into_inner);
            // A panic must not leave `wait` waiting forever.
            let walked = catch_unwind(AssertUnwindSafe(|| {
                notes::refresh(&app_dir, &project_id, &root).map(|index| {
                    let set = NoteSet::new(index.notes.iter().map(|note| note.path.clone()));
                    let view = NotesView::of(index, &set);
                    (view, Arc::new(set))
                })
            }));
            let (result, set) = match walked {
                Ok(Ok((view, set))) => (Ok(view), Some(set)),
                Ok(Err(error)) => (Err(CommandError::from(error)), None),
                Err(_) => (Err(CommandError::Internal), None),
            };
            let (lock, ready) = &*shared;
            if let Ok(mut slot) = lock.lock()
                && slot.generation == generation
            {
                slot.result = Some(result);
                slot.set = set;
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
            slot.set = None;
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

impl NoteIndex {
    /// The notes of this project's last walk, once it is done.
    pub fn note_set(&self, project_id: &str) -> Option<Arc<NoteSet>> {
        let (lock, ready) = &*self.shared;
        let mut slot = lock.lock().ok()?;
        loop {
            if slot.project.as_deref() != Some(project_id) {
                return None;
            }
            if slot.result.is_some() {
                return slot.set.clone();
            }
            slot = ready.wait(slot).ok()?;
        }
    }
}

impl Workspace {
    /// The open project's notes for resolving links, after its walk.
    pub(super) fn note_set(&self) -> Result<Arc<NoteSet>, CommandError> {
        for _ in 0..3 {
            let Some((id, root)) = self.open_root()? else {
                return Err(CommandError::NoProject);
            };
            self.note_index()
                .ensure(self.app_dir()?.to_path_buf(), &id, &root);
            if let Some(set) = self.note_index().note_set(&id) {
                return Ok(set);
            }
        }
        Err(CommandError::Internal)
    }

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
