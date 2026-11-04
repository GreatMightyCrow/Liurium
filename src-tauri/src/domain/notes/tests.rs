use std::{
    fs::{self, File},
    path::PathBuf,
    time::{Duration, SystemTime},
};

use tempfile::TempDir;

use super::*;
use crate::storage::db::CACHE_DIR;
use crate::test_support::{TreeSnapshot, damage, temp_dir};

const ID: &str = "6a1f0c3e-9b2d-4e8f-a7c6-5d4b3a291807";

struct Fixture {
    dir: TempDir,
    project: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = temp_dir();
        let project = dir.path().join("project");
        fs::create_dir_all(project.join("notes")).expect("project");
        fs::create_dir(dir.path().join("app")).expect("app data");
        Self { dir, project }
    }

    fn app(&self) -> PathBuf {
        self.dir.path().join("app")
    }

    fn file(&self, rel: &str, text: &str) {
        let path = self.project.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("folders");
        fs::write(path, text).expect("file");
    }

    fn refresh(&self) -> Index {
        let root = ProjectRoot::open(&self.project).expect("root");
        refresh(&self.app(), ID, &root).expect("refresh")
    }
}

fn paths(index: &Index) -> Vec<&str> {
    index.notes.iter().map(|note| note.path.as_str()).collect()
}

#[test]
fn the_first_refresh_builds_the_cache_from_the_files() {
    let f = Fixture::new();
    f.file("b.md", "bb");
    f.file("notes/A.md", "a");
    f.file("node_modules/x/README.md", "not a note");

    let index = f.refresh();

    assert!(index.rebuilt);
    assert_eq!(paths(&index), ["b.md", "notes/A.md"]);
    assert_eq!(
        index.changes,
        Changes {
            added: 2,
            changed: 0,
            removed: 0
        }
    );
    assert_eq!(index.notes[0].size, 2);
    assert!(f.app().join(CACHE_DIR).join(format!("{ID}.db")).is_file());
}

#[test]
fn a_second_refresh_without_changes_writes_no_row() {
    let f = Fixture::new();
    f.file("a.md", "a");
    f.file("notes/b.md", "b");
    let first = f.refresh();

    let second = f.refresh();

    assert!(!second.rebuilt);
    assert_eq!(second.changes, Changes::default());
    assert_eq!(second.notes, first.notes);
}

#[test]
fn only_added_changed_and_removed_notes_are_written() {
    let f = Fixture::new();
    f.file("keep.md", "same");
    f.file("edit.md", "old");
    f.file("touch.md", "same size");
    f.file("gone.md", "x");
    f.refresh();

    f.file("edit.md", "longer text");
    // Same size, later time: noticed by the time (M2-003 D2).
    let later = SystemTime::now() + Duration::from_secs(5);
    File::options()
        .write(true)
        .open(f.project.join("touch.md"))
        .expect("file")
        .set_modified(later)
        .expect("time");
    fs::remove_file(f.project.join("gone.md")).expect("remove");
    f.file("notes/new.md", "new");

    let index = f.refresh();

    assert_eq!(
        index.changes,
        Changes {
            added: 1,
            changed: 2,
            removed: 1
        }
    );
    assert_eq!(
        paths(&index),
        ["edit.md", "keep.md", "notes/new.md", "touch.md"]
    );
}

#[test]
fn a_deleted_cache_is_built_again_with_the_same_notes() {
    let f = Fixture::new();
    f.file("a.md", "a");
    f.file("notes/b.md", "bb");
    let first = f.refresh();
    fs::remove_dir_all(f.app().join(CACHE_DIR)).expect("delete cache");

    let again = f.refresh();

    assert!(again.rebuilt);
    assert_eq!(again.notes, first.notes);
}

#[test]
fn a_damaged_cache_is_built_again_with_the_same_notes() {
    let f = Fixture::new();
    for n in 0..200 {
        f.file(&format!("notes/{n:03}.md"), "text");
    }
    let first = f.refresh();
    damage(&f.app().join(CACHE_DIR).join(format!("{ID}.db")));

    let again = f.refresh();

    assert!(again.rebuilt);
    assert_eq!(again.notes, first.notes);
}

#[test]
fn refreshing_never_writes_into_the_project() {
    let f = Fixture::new();
    f.file("a.md", "a");
    f.file("notes/b.md", "b");
    let before = TreeSnapshot::of(&f.project);

    f.refresh();
    f.refresh();

    before.assert_unchanged(&f.project);
}

#[test]
fn skipped_items_and_the_limit_are_reported() {
    let f = Fixture::new();
    for name in ["a.md", "b.md", "c.md"] {
        f.file(name, "x");
    }
    let outside = f.dir.path().join("outside");
    fs::create_dir(&outside).expect("folder");
    crate::test_support::junction(&f.project.join("escape"), &outside);

    let root = ProjectRoot::open(&f.project).expect("root");

    let full = refresh(&f.app(), ID, &root).expect("refresh");
    assert!(!full.truncated);
    assert_eq!(full.skipped.links_outside, 1);

    let limited = refresh_with(
        &f.app(),
        ID,
        &root,
        Limits {
            notes: 2,
            depth: 64,
        },
    )
    .expect("refresh");
    assert!(limited.truncated);
    assert_eq!(limited.notes.len(), 2);
}

#[test]
fn times_before_1970_are_negative() {
    assert_eq!(nanos(UNIX_EPOCH), 0);
    // Windows keeps file times in steps of 100 ns.
    assert_eq!(nanos(UNIX_EPOCH + Duration::from_nanos(300)), 300);
    assert_eq!(nanos(UNIX_EPOCH - Duration::from_nanos(300)), -300);
}
