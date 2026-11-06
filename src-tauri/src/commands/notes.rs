//! The notes of the open project (M3-002). Rust walks the project in the background
//! as soon as it opens; `list_notes` waits for that walk and returns what the cache
//! holds. The page sends nothing and gets only paths below the open project, no
//! content.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{self, Index, images::ImageSet, links::NoteSet};
use crate::storage::fs::{Limits, ProjectRoot, RelPath, Skipped};

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
    /// The images of the last walk: all the page can be given (M3-013).
    images: Option<Arc<ImageSet>>,
    /// Notes that appeared at a walk after a change outside, oldest first; a note
    /// that lost its file may have moved to one of them (M3-008).
    recent: Vec<(String, Instant)>,
}

/// How long a new note counts as new. Tools that move a file by copying it and then
/// deleting the original report the two apart.
const RECENT_FOR: Duration = Duration::from_secs(10);

/// Whether two lists show the same, apart from the size and time of the open note,
/// which change with every save of its own (M3-008).
fn same_list(old: &NotesView, new: &NotesView, open: Option<&str>) -> bool {
    match (old, new) {
        (
            NotesView::Ready {
                notes: old_notes,
                skipped: old_skipped,
                truncated: old_truncated,
                empty_folders: old_empty,
                ..
            },
            NotesView::Ready {
                notes: new_notes,
                skipped: new_skipped,
                truncated: new_truncated,
                empty_folders: new_empty,
                ..
            },
        ) => {
            old_skipped == new_skipped
                && old_truncated == new_truncated
                && old_empty == new_empty
                && old_notes.len() == new_notes.len()
                && old_notes.iter().zip(new_notes).all(|(old, new)| {
                    old == new
                        || (old.path == new.path
                            && old.link == new.link
                            && open == Some(old.path.as_str()))
                })
        }
        _ => old == new,
    }
}

/// One walk, as a list for the page and sets for looking things up.
fn walked(
    app_dir: &Path,
    project_id: &str,
    root: &ProjectRoot,
) -> Result<(NotesView, Arc<NoteSet>, Arc<ImageSet>), crate::storage::db::DbError> {
    let mut index = notes::refresh(app_dir, project_id, root)?;
    let images = Arc::new(std::mem::take(&mut index.images));
    let set = NoteSet::with_aliases(
        index.notes.iter().map(|note| note.path.clone()),
        &index.aliases,
    );
    let view = NotesView::of(index, &set);
    Ok((view, Arc::new(set), images))
}

fn paths_of(view: &NotesView) -> Vec<&str> {
    match view {
        NotesView::Ready { notes, .. } => notes.iter().map(|note| note.path.as_str()).collect(),
        NotesView::NoProject => Vec::new(),
    }
}

impl NoteIndex {
    /// Walks again after a change outside and returns whether the list differs (M3-008).
    /// Unlike `start`, the old list stays usable until the new one is ready, and a
    /// failed walk keeps it. A missing project folder is no reason to empty the list.
    pub fn rescan(
        &self,
        app_dir: &Path,
        project_id: &str,
        root: &ProjectRoot,
        open: Option<&str>,
    ) -> bool {
        if !root.path().exists() {
            return false;
        }
        let _one_at_a_time = self.walking.lock().unwrap_or_else(PoisonError::into_inner);
        let (lock, ready) = &*self.shared;
        let (generation, old) = {
            let Ok(slot) = lock.lock() else {
                return false;
            };
            if slot.project.as_deref() != Some(project_id) {
                return false;
            }
            (slot.generation, slot.result.clone())
        };
        let walk = catch_unwind(AssertUnwindSafe(|| walked(app_dir, project_id, root)));
        let Ok(Ok((view, set, images))) = walk else {
            return false;
        };
        let Ok(mut slot) = lock.lock() else {
            return false;
        };
        if slot.generation != generation {
            return false;
        }
        let differs = match &old {
            Some(Ok(old)) => {
                let known = paths_of(old);
                let now = Instant::now();
                slot.recent
                    .retain(|(_, since)| now.duration_since(*since) < RECENT_FOR);
                for path in paths_of(&view) {
                    if !known.contains(&path) {
                        slot.recent.retain(|(other, _)| other != path);
                        slot.recent.push((path.to_owned(), now));
                    }
                }
                // An image's address holds its stamp, so a changed image is a new address.
                !same_list(old, &view, open) || slot.images.as_ref() != Some(&images)
            }
            _ => true,
        };
        slot.result = Some(Ok(view));
        slot.set = Some(set);
        slot.images = Some(images);
        drop(slot);
        ready.notify_all();
        differs
    }

    /// Notes that appeared lately, oldest first.
    pub fn recent_added(&self, project_id: &str) -> Vec<RelPath> {
        let (lock, _) = &*self.shared;
        let Ok(slot) = lock.lock() else {
            return Vec::new();
        };
        if slot.project.as_deref() != Some(project_id) {
            return Vec::new();
        }
        slot.recent
            .iter()
            .filter(|(_, since)| since.elapsed() < RECENT_FOR)
            .filter_map(|(path, _)| RelPath::parse(path).ok())
            .collect()
    }

    /// Starts walking a project on its own thread.
    pub fn start(&self, app_dir: PathBuf, project_id: String, root: ProjectRoot) {
        let (lock, _) = &*self.shared;
        let Ok(mut slot) = lock.lock() else {
            return;
        };
        if slot.project.as_deref() != Some(project_id.as_str()) {
            slot.recent.clear();
        }
        slot.generation += 1;
        slot.project = Some(project_id.clone());
        slot.result = None;
        slot.set = None;
        slot.images = None;
        let generation = slot.generation;
        drop(slot);

        let shared = Arc::clone(&self.shared);
        let walking = Arc::clone(&self.walking);
        std::thread::spawn(move || {
            // A poisoned lock only means an earlier walk panicked; the cache is
            // written in one transaction, so walking on is safe.
            let _one_at_a_time = walking.lock().unwrap_or_else(PoisonError::into_inner);
            // A panic must not leave `wait` waiting forever.
            let walk = catch_unwind(AssertUnwindSafe(|| walked(&app_dir, &project_id, &root)));
            let (result, set, images) = match walk {
                Ok(Ok((view, set, images))) => (Ok(view), Some(set), Some(images)),
                Ok(Err(error)) => (Err(CommandError::from(error)), None, None),
                Err(_) => (Err(CommandError::Internal), None, None),
            };
            let (lock, ready) = &*shared;
            if let Ok(mut slot) = lock.lock()
                && slot.generation == generation
            {
                slot.result = Some(result);
                slot.set = set;
                slot.images = images;
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
            slot.images = None;
            slot.recent.clear();
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

    /// The images of this project's last walk, without waiting for one: `None` while
    /// there is no result, so a request during a walk gets no image rather than a wait.
    pub fn image_set(&self, project_id: &str) -> Option<Arc<ImageSet>> {
        let (lock, _) = &*self.shared;
        let slot = lock.lock().ok()?;
        if slot.project.as_deref() != Some(project_id) {
            return None;
        }
        slot.images.clone()
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
