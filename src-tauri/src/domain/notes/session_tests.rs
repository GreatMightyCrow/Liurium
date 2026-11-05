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
fn a_note_deleted_outside_is_not_saved_and_overwrite_writes_it_again() {
    let f = fixture();
    f.write("Plan.md", b"mine");
    let mut note = f.open("Plan.md");
    fs::remove_file(f.project.join("Plan.md")).expect("remove");

    assert_eq!(
        note.update(&f.root, "kept", true).expect("save"),
        Saved::Gone
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

// Changes made outside, seen by a look at the disk (M3-008).

const NO_NEW_NOTES: &[RelPath] = &[];

fn look(f: &Fixture, note: &mut Session) -> Outside {
    note.reconcile(&f.root, false, NO_NEW_NOTES).expect("look")
}

#[test]
fn a_look_finds_nothing_when_only_this_session_wrote() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    assert_eq!(look(&f, &mut note), Outside::Same);
    note.update(&f.root, "two", true).expect("save");
    assert!(!note.differs_on_disk(&f.root));
    assert_eq!(look(&f, &mut note), Outside::Same);
    assert_eq!(note.revision(), 0);
}

#[test]
fn a_change_outside_without_unsaved_text_reloads_and_raises_the_revision() {
    let f = fixture();
    f.write("Plan.md", b"one\n");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", b"from outside\n");
    assert!(note.differs_on_disk(&f.root));

    assert_eq!(look(&f, &mut note), Outside::Reloaded);

    assert_eq!(note.text(), "from outside\n");
    assert_eq!(note.revision(), 1);
    assert!(!note.has_draft());
    assert!(!note.differs_on_disk(&f.root));
}

#[test]
fn a_change_outside_with_unsaved_text_stops_saving_and_keeps_both_texts() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    f.change_outside("Plan.md", b"theirs");

    assert_eq!(look(&f, &mut note), Outside::Conflict);

    assert!(note.in_conflict());
    assert_eq!(note.text(), "mine");
    assert_eq!(note.save(&f.root).expect("save"), Saved::Conflict);
    assert_eq!(f.bytes("Plan.md"), b"theirs");
    // A conflict waiting is nothing new, so the page is not told again.
    assert!(!note.differs_on_disk(&f.root));
}

#[test]
fn a_file_touched_but_not_changed_keeps_the_note_as_it_is() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    f.change_outside("Plan.md", b"one");

    assert_eq!(look(&f, &mut note), Outside::Same);

    assert_eq!(note.text(), "mine");
    assert_eq!(note.save(&f.root).expect("save"), Saved::Saved);
    assert_eq!(f.bytes("Plan.md"), b"mine");
}

#[test]
fn a_file_that_now_says_what_the_user_typed_leaves_nothing_to_decide() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "same", false).expect("draft");
    f.change_outside("Plan.md", b"same");

    assert_eq!(look(&f, &mut note), Outside::Same);

    assert!(!note.has_draft());
    assert!(!note.in_conflict());
}

#[test]
fn text_from_before_a_reload_becomes_a_conflict_and_never_overwrites() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", b"theirs");
    assert_eq!(look(&f, &mut note), Outside::Reloaded);

    let saved = note
        .update_at(&f.root, "typed before", true, 0)
        .expect("update");

    assert_eq!(saved, Saved::Conflict);
    assert_eq!(f.bytes("Plan.md"), b"theirs");
    assert_eq!(note.text(), "typed before");
    assert!(note.in_conflict());
    // With the current revision, saving works as ever once the choice is made.
    note.resolve(&f.root, Choice::Overwrite, false)
        .expect("choice");
    assert_eq!(f.bytes("Plan.md"), b"typed before");
    assert_eq!(
        note.update_at(&f.root, "next", true, 1).expect("save"),
        Saved::Saved
    );
}

#[test]
fn a_file_now_unreadable_keeps_the_old_text_and_stops_saving() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    f.change_outside("Plan.md", &[0xFF, 0xFE, 0x00]);

    assert_eq!(look(&f, &mut note), Outside::Conflict);

    assert_eq!(note.text(), "one");
    assert_eq!(f.bytes("Plan.md"), [0xFF, 0xFE, 0x00]);
}

#[test]
fn a_deleted_file_is_not_written_back_while_the_note_stays_open() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");

    assert_eq!(look(&f, &mut note), Outside::Gone);

    assert!(note.is_gone());
    assert_eq!(note.text(), "mine");
    assert_eq!(
        note.update(&f.root, "more", true).expect("save"),
        Saved::Gone
    );
    assert!(!f.project.join("Plan.md").exists());
    assert!(!note.differs_on_disk(&f.root));
}

#[test]
fn saving_finds_a_deleted_file_by_itself() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");

    assert_eq!(
        note.update(&f.root, "mine", true).expect("save"),
        Saved::Gone
    );

    assert!(!f.project.join("Plan.md").exists());
}

#[test]
fn create_again_brings_the_note_and_its_folder_back_with_the_text() {
    let f = fixture();
    f.write("Ideas/Plan.md", b"one");
    let mut note = f.open("Ideas/Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    fs::remove_dir_all(f.project.join("Ideas")).expect("delete");
    assert_eq!(look(&f, &mut note), Outside::Gone);

    note.resolve(&f.root, Choice::Overwrite, false)
        .expect("create");

    assert_eq!(f.bytes("Ideas/Plan.md"), b"mine");
    assert!(!note.is_gone());
    assert_eq!(look(&f, &mut note), Outside::Same);
}

#[test]
fn create_again_is_refused_in_a_write_protected_project() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = Session::open(&f.root, path("Plan.md"), true, false).expect("open");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");
    assert_eq!(
        note.reconcile(&f.root, true, NO_NEW_NOTES).expect("look"),
        Outside::Gone
    );

    assert!(matches!(
        note.resolve(&f.root, Choice::Overwrite, true),
        Err(NoteError::ReadOnly)
    ));
    assert!(!f.project.join("Plan.md").exists());
}

#[test]
fn leaving_a_deleted_note_keeps_its_text_as_a_copy_and_not_under_the_old_name() {
    let f = fixture();
    f.write("Ideas/Plan.md", b"one");
    let mut note = f.open("Ideas/Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    fs::remove_dir_all(f.project.join("Ideas")).expect("delete");
    assert_eq!(look(&f, &mut note), Outside::Gone);

    let kept = note.flush(&f.root).expect("flush");

    assert_eq!(
        kept,
        Some(Resolved::KeptBoth {
            path: path("Ideas/Plan (conflict).md")
        })
    );
    assert_eq!(f.bytes("Ideas/Plan (conflict).md"), b"mine");
    assert!(!f.project.join("Ideas/Plan.md").exists());
}

#[test]
fn a_file_that_comes_back_continues_by_the_usual_rules() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");
    assert_eq!(look(&f, &mut note), Outside::Gone);
    f.change_outside("Plan.md", b"restored");

    assert_eq!(look(&f, &mut note), Outside::Reloaded);

    assert!(!note.is_gone());
    assert_eq!(note.text(), "restored");
}

#[test]
fn a_rename_is_followed_when_exactly_one_new_note_has_the_same_text() {
    let f = fixture();
    f.write("Plan.md", b"one\n");
    f.write("Other.md", b"different");
    let mut note = f.open("Plan.md");
    note.update(&f.root, "mine", false).expect("draft");
    fs::rename(f.project.join("Plan.md"), f.project.join("Ideas/Moved.md")).expect("rename");

    let outside = note
        .reconcile(&f.root, false, &[path("Other.md"), path("Ideas/Moved.md")])
        .expect("look");

    assert_eq!(outside, Outside::Moved);
    assert_eq!(*note.path(), path("Ideas/Moved.md"));
    assert_eq!(note.text(), "mine");
    assert_eq!(note.save(&f.root).expect("save"), Saved::Saved);
    assert_eq!(f.bytes("Ideas/Moved.md"), b"mine");
    assert!(!f.project.join("Plan.md").exists());
}

#[test]
fn two_new_notes_with_the_same_text_are_no_rename() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    f.write("A.md", b"one");
    f.write("B.md", b"one");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");

    let outside = note
        .reconcile(&f.root, false, &[path("A.md"), path("B.md")])
        .expect("look");

    assert_eq!(outside, Outside::Gone);
    assert_eq!(*note.path(), path("Plan.md"));
}

#[test]
fn a_new_note_with_other_text_of_the_same_size_is_no_rename() {
    let f = fixture();
    f.write("Plan.md", b"one");
    let mut note = f.open("Plan.md");
    f.write("A.md", b"two");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");

    let outside = note
        .reconcile(&f.root, false, &[path("A.md")])
        .expect("look");

    assert_eq!(outside, Outside::Gone);
}

#[test]
fn an_empty_note_never_follows_because_every_empty_file_would_match() {
    let f = fixture();
    f.write("Plan.md", b"");
    let mut note = f.open("Plan.md");
    f.write("Empty.md", b"");
    fs::remove_file(f.project.join("Plan.md")).expect("delete");

    let outside = note
        .reconcile(&f.root, false, &[path("Empty.md")])
        .expect("look");

    assert_eq!(outside, Outside::Gone);
}

#[test]
fn a_rename_of_only_upper_and_lower_case_keeps_the_note_and_updates_its_spelling() {
    let f = fixture();
    f.write("plan.md", b"one");
    let mut note = f.open("plan.md");
    fs::rename(f.project.join("plan.md"), f.project.join("Plan.md")).expect("rename");

    let outside = note
        .reconcile(&f.root, false, &[path("Plan.md")])
        .expect("look");

    assert_eq!(outside, Outside::Moved);
    assert_eq!(note.path().to_string(), "Plan.md");
}
