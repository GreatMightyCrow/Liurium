//! Notes that change outside Liurium (M3-008). A report from Windows is only a
//! wake-up: Rust then looks at the disk itself and decides from what is there, so a
//! lost, doubled, or oddly ordered report cannot cause a wrong decision. The page
//! learns only that something changed, as a number; it asks for the rest through the
//! commands it already uses.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::State;

use super::{CommandError, Workspace, editor::Editor, notes::NoteIndex, projects::blocking};
use crate::storage::fs::{ProjectRoot, SKIPPED_FOLDERS};

/// A burst of reports counts once it has been quiet this long…
const QUIET: Duration = Duration::from_millis(300);
/// …or after this long, so a long burst still shows.
const AT_MOST: Duration = Duration::from_secs(2);
/// A waiting page asks again after this long, so a reloaded page leaves nothing behind.
const WAIT_AT_MOST: Duration = Duration::from_secs(30);
/// Clicking back and forth between windows looks at the disk at most this often.
const FOCUS_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub struct Changes {
    count: Arc<(Mutex<u64>, Condvar)>,
    last_focus: Arc<Mutex<Option<Instant>>>,
    /// Dropping it closes the report channel, which ends the thread that listens.
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

impl Changes {
    fn bump(&self) {
        let (lock, changed) = &*self.count;
        if let Ok(mut count) = lock.lock() {
            *count += 1;
        }
        changed.notify_all();
    }

    /// The count once it differs from `seen`, or `seen` after `at_most`.
    pub(super) fn wait(&self, seen: u64, at_most: Duration) -> Result<u64, CommandError> {
        let (lock, changed) = &*self.count;
        let count = lock.lock().map_err(|_| CommandError::Internal)?;
        let (count, _) = changed
            .wait_timeout_while(count, at_most, |count| *count == seen)
            .map_err(|_| CommandError::Internal)?;
        Ok(*count)
    }

    fn stop_watching(&self) {
        if let Ok(mut watcher) = self.watcher.lock() {
            *watcher = None;
        }
    }
}

/// Whether a reported path can matter: only what the walk visits. Liurium's own database
/// lives in `.liurium`, so without this its writes would wake it again and again.
fn matters(root: &Path, path: &Path) -> bool {
    let Ok(below) = path.strip_prefix(root) else {
        return true;
    };
    !below.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        name.starts_with('.') || SKIPPED_FOLDERS.contains(&name.to_lowercase().as_str())
    })
}

/// Waits for a report, then for quiet, then looks. Ends when the watcher is dropped.
fn listen(reports: &Receiver<()>, look: impl Fn()) {
    while reports.recv().is_ok() {
        let started = Instant::now();
        loop {
            let left = AT_MOST.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            match reports.recv_timeout(QUIET.min(left)) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        look();
    }
}

/// What a look at the disk needs. It holds no watcher, so the last `Workspace` going
/// away drops the watcher and ends the listening thread.
struct Looker {
    index: NoteIndex,
    editor: Editor,
    changes: Changes,
    app_dir: PathBuf,
    id: String,
    root: ProjectRoot,
}

impl Looker {
    fn look(&self) {
        let open = self.editor.open_path(&self.id);
        let listed = self
            .index
            .rescan(&self.app_dir, &self.id, &self.root, open.as_deref());
        if listed || self.editor.differs_on_disk(&self.id) {
            self.changes.bump();
        }
    }
}

impl Workspace {
    fn looker(&self, id: String, root: ProjectRoot) -> Result<Looker, CommandError> {
        Ok(Looker {
            index: self.note_index().clone(),
            editor: self.editor().clone(),
            changes: self.changes().clone(),
            app_dir: self.app_dir()?.to_path_buf(),
            id,
            root,
        })
    }

    /// Starts watching a project's folder, replacing the last watcher. If that fails,
    /// for example on some network drives, the check at window focus still works
    /// (owner decision Q1).
    pub(super) fn watch(&self, id: String, root: ProjectRoot) {
        self.changes().stop_watching();
        #[cfg(feature = "e2e")]
        if crate::e2e::no_watch() {
            return;
        }
        let Ok(looker) = self.looker(id, root.clone()) else {
            return;
        };
        let (report, reports) = mpsc::channel();
        let folder = root.path().to_path_buf();
        let handler = move |event: notify::Result<notify::Event>| {
            let wake = event.map_or(true, |event| {
                event.paths.is_empty() || event.paths.iter().any(|path| matters(&folder, path))
            });
            if wake {
                // The listener has gone only when this watcher is being dropped.
                report.send(()).ok();
            }
        };
        let Ok(mut watcher) = notify::recommended_watcher(handler) else {
            return;
        };
        if watcher
            .watch(root.path(), RecursiveMode::Recursive)
            .is_err()
        {
            return;
        }
        if let Ok(mut slot) = self.changes().watcher.lock() {
            *slot = Some(watcher);
        }
        std::thread::spawn(move || listen(&reports, || looker.look()));
    }

    pub(super) fn stop_watching(&self) {
        self.changes().stop_watching();
    }

    /// Looks at the disk when the window gets focus, because reports can fail on
    /// network and USB drives (owner decision Q1).
    pub fn check_note_changes(&self) -> Result<(), CommandError> {
        {
            let mut last = self
                .changes()
                .last_focus
                .lock()
                .map_err(|_| CommandError::Internal)?;
            let now = Instant::now();
            if last.is_some_and(|last| now.duration_since(last) < FOCUS_EVERY) {
                return Ok(());
            }
            *last = Some(now);
        }
        if let Some((id, root)) = self.open_root()? {
            self.looker(id, root)?.look();
        }
        Ok(())
    }
}

/// Waits until something changed outside, or 30 seconds passed, and returns the count
/// of changes. No paths, no text.
#[tauri::command]
pub async fn wait_note_changes(
    seen: u64,
    workspace: State<'_, Workspace>,
) -> Result<u64, CommandError> {
    let changes = workspace.changes().clone();
    blocking(move || changes.wait(seen, WAIT_AT_MOST)).await
}

#[tauri::command]
pub async fn check_note_changes(workspace: State<'_, Workspace>) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.check_note_changes()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paths_the_walk_would_visit_matter() {
        let root = Path::new(r"C:\project");
        for path in [
            r"C:\project\Plan.md",
            r"C:\project\Ideas\Plan.md",
            r"C:\project\Ideas",
            r"C:\project",
            // Outside the root says nothing about the root: look rather than miss it.
            r"D:\elsewhere\Plan.md",
        ] {
            assert!(matters(root, Path::new(path)), "{path}");
        }
        for path in [
            r"C:\project\.liurium\project.db",
            r"C:\project\.git\index",
            r"C:\project\node_modules\a\README.md",
            r"C:\project\Target\x.md",
            // Liurium's own temporary files start with a dot.
            r"C:\project\Ideas\.1a-2b-3c.liurium-tmp",
        ] {
            assert!(!matters(root, Path::new(path)), "{path}");
        }
    }

    #[test]
    fn a_burst_of_reports_is_one_look_and_a_dropped_watcher_ends_the_listener() {
        let (report, reports) = mpsc::channel();
        for _ in 0..50 {
            report.send(()).expect("sent");
        }
        let looks = std::cell::Cell::new(0);
        let sender = std::thread::spawn(move || {
            std::thread::sleep(QUIET * 3);
            drop(report);
        });
        listen(&reports, || looks.set(looks.get() + 1));
        sender.join().expect("joined");
        assert_eq!(looks.get(), 1);
    }

    #[test]
    fn a_waiting_page_gets_the_new_count_at_once_and_its_own_after_the_time() {
        let changes = Changes::default();
        assert_eq!(changes.wait(0, Duration::from_millis(10)).ok(), Some(0));
        changes.bump();
        // Already different: no waiting.
        assert_eq!(changes.wait(0, Duration::from_secs(60)).ok(), Some(1));
        let other = changes.clone();
        let waiting = std::thread::spawn(move || other.wait(1, Duration::from_secs(60)).ok());
        std::thread::sleep(Duration::from_millis(50));
        changes.bump();
        assert_eq!(waiting.join().expect("joined"), Some(2));
    }
}
