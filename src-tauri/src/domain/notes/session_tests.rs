//! The open note against real files (M3-003): exact bytes, changes made outside,
//! the three conflict choices, read-only notes, flushing before leaving.

use std::{
    fs::{self, File},
    path::PathBuf,
    time::{Duration, SystemTime},
};

use tempfile::TempDir;

use super::session::*;
use super::text::LineEnding;
use crate::storage::fs::{FsError, ProjectRoot, RelPath};
use crate::test_support::{Snapshot, read_only, temp_dir};

struct Fixture {
    _dir: TempDir,
    project: PathBuf,
    root: ProjectRoot,
}

fn fixture() -> Fixture {
    let dir = temp_dir();
    let project = dir.path().join("project");
    fs::create_dir_all(project.join("Ideas")).expect("project");
    let root = ProjectRoot::open(&project).expect("root");
    Fixture {
        _dir: dir,
        project,
        root,
    }
}

impl Fixture {
    fn write(&self, rel: &str, bytes: &[u8]) {
        fs::write(self.project.join(rel), bytes).expect("file");
    }

    fn bytes(&self, rel: &str) -> Vec<u8> {
        fs::read(self.project.join(rel)).expect("file")
    }

    fn open(&self, rel: &str) -> Session {
        Session::open(&self.root, path(rel), false, false).expect("open")
    }

    /// An outside program changes the file; the later time makes sure the stamp
    /// differs even within one clock tick.
    fn change_outside(&self, rel: &str, bytes: &[u8]) {
        let file_path = self.project.join(rel);
        fs::write(&file_path, bytes).expect("write");
        File::options()
            .write(true)
            .open(&file_path)
            .expect("file")
            .set_modified(SystemTime::now() + Duration::from_secs(5))
            .expect("time");
    }
}

fn path(rel: &str) -> RelPath {
    RelPath::parse(rel).expect("path")
}

#[test]
fn an_edit_is_saved_with_the_files_bom_and_crlf_kept() {
    let f = fixture();
    f.write("Ideas/Plan.md", b"\xEF\xBB\xBF# Plan\r\nline  \r\n");
    let mut note = f.open("Ideas/Plan.md");
    assert_eq!(note.text(), "# Plan\r\nline  \r\n");
    assert_eq!(note.ending(), LineEnding::Crlf);

    let saved = note
        .update(&f.root, "# Plan\r\nline  \r\nmore\r\n", true)
        .expect("save");

    assert_eq!(saved, Saved::Saved);
    assert_eq!(
        f.bytes("Ideas/Plan.md"),
        b"\xEF\xBB\xBF# Plan\r\nline  \r\nmore\r\n"
    );
    assert!(!note.has_draft());
}

#[test]
fn pasted_lf_breaks_are_written_as_the_files_crlf() {
    let f = fixture();
    f.write("Plan.md", b"a\r\n");
    let mut note = f.open("Plan.md");

    note.update(&f.root, "a\r\npasted\nlines\n", true)
        .expect("save");

    assert_eq!(f.bytes("Plan.md"), b"a\r\npasted\r\nlines\r\n");
}

#[test]
fn a_draft_is_kept_until_saved_and_text_equal_to_the_file_is_no_draft() {
    let f = fixture();
    f.write("Plan.md", b"old");
    let mut note = f.open("Plan.md");

    assert_eq!(
        note.update(&f.root, "new", false).expect("draft"),
        Saved::Draft
    );
    assert_eq!(note.text(), "new");
    assert_eq!(f.bytes("Plan.md"), b"old");

    assert_eq!(
        note.update(&f.root, "old", false).expect("same"),
        Saved::Saved
    );
    assert!(!note.has_draft());
}

#[test]
fn a_change_made_outside_is_never_overwritten_by_saving() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", b"theirs");
    let before = Snapshot::of(&f.project.join("Plan.md"));

    let first = note.update(&f.root, "mine, edited", true).expect("save");
    let again = note
        .update(&f.root, "mine, edited more", true)
        .expect("save");

    assert_eq!(first, Saved::Conflict);
    assert_eq!(again, Saved::Conflict);
    assert!(note.in_conflict());
    assert_eq!(note.text(), "mine, edited more");
    before.assert_unchanged(&f.project.join("Plan.md"));
}

#[test]
fn reload_drops_the_draft_and_shows_the_outside_change() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", b"theirs");
    note.update(&f.root, "draft", true).expect("conflict");

    let resolved = note
        .resolve(&f.root, Choice::Reload, false)
        .expect("reload");

    assert_eq!(resolved, Resolved::Reloaded);
    assert_eq!(note.text(), "theirs");
    assert!(!note.in_conflict());
    assert_eq!(
        note.update(&f.root, "theirs, edited", true).expect("save"),
        Saved::Saved
    );
    assert_eq!(f.bytes("Plan.md"), b"theirs, edited");
}

#[test]
fn overwrite_writes_the_draft_over_the_outside_change() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", b"theirs");
    note.update(&f.root, "mine, edited", true)
        .expect("conflict");

    let resolved = note
        .resolve(&f.root, Choice::Overwrite, false)
        .expect("overwrite");

    assert_eq!(resolved, Resolved::Saved);
    assert_eq!(f.bytes("Plan.md"), b"mine, edited");
    assert!(!note.in_conflict() && !note.has_draft());
}

#[test]
fn keep_both_writes_a_conflict_copy_and_continues_there() {
    let f = fixture();
    f.write("Ideas/Plan.md", b"mine");
    f.write("Ideas/Plan (conflict).md", b"an older copy");
    let mut note = f.open("Ideas/Plan.md");
    f.change_outside("Ideas/Plan.md", b"theirs");
    note.update(&f.root, "mine, edited", true)
        .expect("conflict");

    let resolved = note
        .resolve(&f.root, Choice::KeepBoth, false)
        .expect("keep both");

    let copy = path("Ideas/Plan (conflict 2).md");
    assert_eq!(resolved, Resolved::KeptBoth { path: copy.clone() });
    assert_eq!(note.path(), &copy);
    assert_eq!(f.bytes("Ideas/Plan.md"), b"theirs");
    assert_eq!(f.bytes("Ideas/Plan (conflict).md"), b"an older copy");
    assert_eq!(f.bytes("Ideas/Plan (conflict 2).md"), b"mine, edited");
    note.update(&f.root, "mine, edited again", true)
        .expect("save");
    assert_eq!(f.bytes("Ideas/Plan (conflict 2).md"), b"mine, edited again");
}

#[test]
fn a_note_deleted_outside_is_a_conflict_and_overwrite_writes_it_again() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    fs::remove_file(f.project.join("Plan.md")).expect("remove");

    assert_eq!(
        note.update(&f.root, "kept", true).expect("save"),
        Saved::Conflict
    );
    assert!(!f.project.join("Plan.md").exists());

    note.resolve(&f.root, Choice::Overwrite, false)
        .expect("overwrite");
    assert_eq!(f.bytes("Plan.md"), b"kept");
}

#[test]
fn flushing_saves_the_draft_and_keeps_both_on_a_conflict() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "draft", false).expect("draft");
    assert_eq!(note.flush(&f.root).expect("flush"), None);
    assert_eq!(f.bytes("Plan.md"), b"draft");

    note.update(&f.root, "second draft", false).expect("draft");
    f.change_outside("Plan.md", b"theirs");
    let resolved = note.flush(&f.root).expect("flush");

    assert_eq!(
        resolved,
        Some(Resolved::KeptBoth {
            path: path("Plan (conflict).md")
        })
    );
    assert_eq!(f.bytes("Plan.md"), b"theirs");
    assert_eq!(f.bytes("Plan (conflict).md"), b"second draft");
}

#[test]
fn mixed_line_endings_open_read_only_until_made_uniform() {
    let f = fixture();
    f.write("Plan.md", b"a\r\nb\nc\r\nd");
    let mut note = f.open("Plan.md");
    assert_eq!(note.read_only(), Some(ReadOnly::LineEndings));
    assert!(matches!(
        note.update(&f.root, "x", true),
        Err(NoteError::ReadOnly)
    ));
    assert_eq!(f.bytes("Plan.md"), b"a\r\nb\nc\r\nd");

    let note = Session::open(&f.root, path("Plan.md"), false, true).expect("unify");

    assert_eq!(note.read_only(), None);
    assert_eq!(note.ending(), LineEnding::Crlf);
    assert_eq!(f.bytes("Plan.md"), b"a\r\nb\r\nc\r\nd");
}

#[test]
fn write_protected_files_and_projects_open_read_only() {
    let f = fixture();
    f.write("Locked.md", b"locked");
    read_only(&f.project.join("Locked.md"));
    f.write("Plan.md", b"plan");

    let locked = f.open("Locked.md");
    let in_project = Session::open(&f.root, path("Plan.md"), true, false).expect("open");

    assert_eq!(locked.read_only(), Some(ReadOnly::File));
    assert_eq!(in_project.read_only(), Some(ReadOnly::Project));
    // Even with `unify`, a write-protected note is not written.
    f.write("Mixed.md", b"a\r\nb\n");
    let mixed = Session::open(&f.root, path("Mixed.md"), true, true).expect("open");
    assert_eq!(mixed.read_only(), Some(ReadOnly::Project));
    assert_eq!(f.bytes("Mixed.md"), b"a\r\nb\n");
}

#[test]
fn files_that_are_not_utf8_or_too_large_are_not_opened() {
    let f = fixture();
    f.write("Latin.md", b"caf\xE9");
    f.write("Wide.md", b"\xFF\xFEa\x00");
    let big = vec![b'a'; usize::try_from(MAX_NOTE_BYTES).expect("size") + 1];
    f.write("Big.md", &big);

    for (name, expected) in [
        ("Latin.md", "not utf8"),
        ("Wide.md", "not utf8"),
        ("Big.md", "too large"),
    ] {
        let error = Session::open(&f.root, path(name), false, false).unwrap_err();
        let matched = match expected {
            "not utf8" => matches!(error, NoteError::NotUtf8),
            _ => matches!(error, NoteError::Fs(FsError::TooLarge { .. })),
        };
        assert!(matched, "{name}: {error:?}");
    }
}

#[test]
fn paths_from_the_page_must_be_notes_outside_hidden_and_package_folders() {
    assert!(note_path("Ideas/Plan.md").is_ok());
    for refused in [
        ".liurium/project.db",
        "node_modules/a.md",
        "../x.md",
        "Plan.txt",
    ] {
        assert!(note_path(refused).is_err(), "{refused}");
    }
}
