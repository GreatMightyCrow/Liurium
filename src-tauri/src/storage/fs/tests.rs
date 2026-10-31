//! Real files, junctions, and symbolic links in temp folders. Junctions need no
//! special rights; symbolic links need administrator rights or Developer Mode, so
//! those tests are ignored locally and run in CI (M2-003 decision D3).

use std::time::Duration;

use tempfile::TempDir;

use super::*;
use crate::test_support::{Snapshot, junction, read_only, temp_dir};

const MAX: u64 = 1024 * 1024;

/// A temp folder with the project in `project` and a neighbour in `outside`.
struct Fixture {
    _dir: TempDir,
    project: PathBuf,
    outside: PathBuf,
    root: ProjectRoot,
}

fn fixture() -> Fixture {
    let dir = temp_dir();
    let project = dir.path().join("project");
    let outside = dir.path().join("outside");
    fs::create_dir(&project).expect("project folder");
    fs::create_dir(&outside).expect("outside folder");
    let root = ProjectRoot::open(&project).expect("root");
    Fixture {
        _dir: dir,
        project,
        outside,
        root,
    }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("valid path")
}

fn temp_files(folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(folder)
        .expect("folder")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.to_string_lossy().ends_with(TEMP_SUFFIX))
        .collect()
}

#[test]
fn a_new_file_is_written_and_read_back() {
    let f = fixture();
    let stamp = f
        .root
        .write(&rel("idea.md"), b"hello", Expect::New)
        .expect("write");

    let (bytes, read_stamp) = f.root.read(&rel("idea.md"), MAX).expect("read");

    assert_eq!(bytes, b"hello");
    assert_eq!(read_stamp, stamp);
    assert_eq!(stamp.len, 5);
    assert_eq!(fs::read(f.project.join("idea.md")).expect("file"), b"hello");
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn a_new_file_never_replaces_an_existing_one() {
    let f = fixture();
    fs::write(f.project.join("idea.md"), b"mine").expect("write");
    let before = Snapshot::of(&f.project.join("idea.md"));

    let error = f
        .root
        .write(&rel("idea.md"), b"other", Expect::New)
        .unwrap_err();

    assert!(matches!(error, FsError::AlreadyExists), "{error:?}");
    before.assert_unchanged(&f.project.join("idea.md"));
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn an_unchanged_file_is_replaced() {
    let f = fixture();
    let first = f
        .root
        .write(&rel("idea.md"), b"one", Expect::New)
        .expect("write");

    let second = f
        .root
        .write(&rel("idea.md"), b"two, longer", Expect::Unchanged(first))
        .expect("replace");

    assert_eq!(
        fs::read(f.project.join("idea.md")).expect("file"),
        b"two, longer"
    );
    assert_eq!(second.len, 11);
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn a_file_changed_outside_is_not_replaced() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"one", Expect::New)
        .expect("write");
    fs::write(&path, b"edited elsewhere").expect("outside edit");
    let before = Snapshot::of(&path);

    let error = f
        .root
        .write(&rel("idea.md"), b"two", Expect::Unchanged(stamp))
        .unwrap_err();

    assert!(matches!(error, FsError::Changed), "{error:?}");
    before.assert_unchanged(&path);
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn a_same_size_change_is_noticed_by_its_time() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"one", Expect::New)
        .expect("write");
    fs::write(&path, b"two").expect("outside edit");
    // Two writes can share one clock tick; move the time on like a later edit.
    File::options()
        .write(true)
        .open(&path)
        .expect("file")
        .set_modified(stamp.modified + Duration::from_secs(1))
        .expect("time");
    let before = Snapshot::of(&path);

    let error = f
        .root
        .write(&rel("idea.md"), b"six", Expect::Unchanged(stamp))
        .unwrap_err();

    assert!(matches!(error, FsError::Changed), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_file_deleted_outside_is_not_recreated() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"one", Expect::New)
        .expect("write");
    fs::remove_file(&path).expect("outside delete");

    let error = f
        .root
        .write(&rel("idea.md"), b"two", Expect::Unchanged(stamp))
        .unwrap_err();

    assert!(matches!(error, FsError::Changed), "{error:?}");
    assert!(!path.exists());
}

#[test]
fn a_read_only_file_is_not_replaced() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"one", Expect::New)
        .expect("write");
    read_only(&path);
    let before = Snapshot::of(&path);

    let error = f
        .root
        .write(&rel("idea.md"), b"two", Expect::Unchanged(stamp))
        .unwrap_err();

    assert!(matches!(error, FsError::ReadOnly), "{error:?}");
    before.assert_unchanged(&path);
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn an_interrupted_write_leaves_the_target_intact() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"old", Expect::New)
        .expect("write");
    let before = Snapshot::of(&path);

    // A crash after the temp file is flushed: no commit, no clean-up.
    let staged = f
        .root
        .stage(&rel("idea.md"), b"new content", Expect::Unchanged(stamp))
        .expect("stage");
    std::mem::forget(staged);

    before.assert_unchanged(&path);
    let left = temp_files(&f.project);
    assert_eq!(left.len(), 1);
    assert_eq!(fs::read(&left[0]).expect("temp file"), b"new content");
    let (bytes, _) = f.root.read(&rel("idea.md"), MAX).expect("read");
    assert_eq!(bytes, b"old");
}

#[test]
fn a_change_between_stage_and_commit_removes_the_temp_file() {
    let f = fixture();
    let path = f.project.join("idea.md");
    let stamp = f
        .root
        .write(&rel("idea.md"), b"old", Expect::New)
        .expect("write");
    let staged = f
        .root
        .stage(&rel("idea.md"), b"new", Expect::Unchanged(stamp))
        .expect("stage");
    fs::write(&path, b"edited elsewhere").expect("outside edit");
    let before = Snapshot::of(&path);

    let error = staged.commit().unwrap_err();

    assert!(matches!(error, FsError::Changed), "{error:?}");
    before.assert_unchanged(&path);
    assert!(temp_files(&f.project).is_empty());
}

#[test]
fn reading_checks_kind_existence_and_size() {
    let f = fixture();
    fs::create_dir(f.project.join("notes")).expect("folder");
    fs::write(f.project.join("big.md"), [b'x'; 10]).expect("write");

    let folder = f.root.read(&rel("notes"), MAX).unwrap_err();
    let missing = f.root.read(&rel("missing.md"), MAX).unwrap_err();
    let large = f.root.read(&rel("big.md"), 5).unwrap_err();

    assert!(matches!(folder, FsError::WrongKind), "{folder:?}");
    assert!(matches!(missing, FsError::NotFound), "{missing:?}");
    assert!(
        matches!(large, FsError::TooLarge { len: 10, max: 5 }),
        "{large:?}"
    );
    assert!(f.root.read(&rel("big.md"), 10).is_ok());
}

#[test]
fn writing_needs_an_existing_folder() {
    let f = fixture();

    let error = f
        .root
        .write(&rel("notes/idea.md"), b"x", Expect::New)
        .unwrap_err();
    assert!(matches!(error, FsError::NotFound), "{error:?}");

    f.root.create_dir(&rel("notes/2026")).expect("folders");
    f.root
        .write(&rel("notes/2026/idea.md"), b"x", Expect::New)
        .expect("write");
    assert!(f.project.join(r"notes\2026\idea.md").is_file());
}

#[test]
fn liurium_and_git_folders_are_write_protected() {
    let f = fixture();
    fs::create_dir(f.project.join(".liurium")).expect("folder");
    fs::create_dir(f.project.join(".git")).expect("folder");
    fs::write(f.project.join(r".liurium\project.db"), b"db").expect("write");
    junction(&f.project.join("meta"), &f.project.join(".liurium"));
    let before = Snapshot::of(&f.project.join(r".liurium\project.db"));

    for text in [
        ".liurium/project.db",
        ".LIURIUM/new",
        ".git/config",
        ".Git/hooks/pre-commit",
        "meta/project.db",
        "notes/.git/config",
    ] {
        let error = f.root.write(&rel(text), b"x", Expect::New).unwrap_err();
        assert!(matches!(error, FsError::Protected), "{text}: {error:?}");
        let error = f.root.create_dir(&rel(text)).unwrap_err();
        assert!(matches!(error, FsError::Protected), "{text}: {error:?}");
    }
    before.assert_unchanged(&f.project.join(r".liurium\project.db"));
    // Reading stays allowed.
    let (bytes, _) = f.root.read(&rel("meta/project.db"), MAX).expect("read");
    assert_eq!(bytes, b"db");
}

#[test]
fn a_junction_inside_the_project_is_followed() {
    let f = fixture();
    fs::create_dir(f.project.join("notes")).expect("folder");
    junction(&f.project.join("alias"), &f.project.join("notes"));

    f.root
        .write(&rel("alias/idea.md"), b"via link", Expect::New)
        .expect("write");

    assert_eq!(
        fs::read(f.project.join(r"notes\idea.md")).expect("file"),
        b"via link"
    );
    let (bytes, _) = f.root.read(&rel("alias/idea.md"), MAX).expect("read");
    assert_eq!(bytes, b"via link");
    assert!(
        fs::symlink_metadata(f.project.join("alias"))
            .expect("link")
            .is_symlink()
    );
}

#[test]
fn a_junction_out_of_the_project_is_refused() {
    let f = fixture();
    fs::write(f.outside.join("secret.txt"), b"secret").expect("write");
    junction(&f.project.join("escape"), &f.outside);

    let read = f.root.read(&rel("escape/secret.txt"), MAX).unwrap_err();
    let write = f
        .root
        .write(&rel("escape/new.md"), b"x", Expect::New)
        .unwrap_err();
    let folder = f.root.create_dir(&rel("escape/sub")).unwrap_err();

    assert!(matches!(read, FsError::OutsideRoot), "{read:?}");
    assert!(matches!(write, FsError::OutsideRoot), "{write:?}");
    assert!(matches!(folder, FsError::OutsideRoot), "{folder:?}");
    let names: Vec<_> = fs::read_dir(&f.outside)
        .expect("folder")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names, ["secret.txt"]);
}

#[test]
fn a_junction_to_a_missing_folder_is_a_broken_link() {
    let f = fixture();
    let gone = f.outside.join("gone");
    fs::create_dir(&gone).expect("folder");
    junction(&f.project.join("dangling"), &gone);
    fs::remove_dir(&gone).expect("remove target");

    let error = f
        .root
        .write(&rel("dangling/idea.md"), b"x", Expect::New)
        .unwrap_err();

    assert!(matches!(error, FsError::BrokenLink), "{error:?}");
    assert!(!gone.exists());
}

#[test]
fn paths_longer_than_260_characters_work() {
    let f = fixture();
    let folder = ["a-fairly-long-folder-name-for-testing-paths"; 7].join("/");
    let file = format!("{folder}/note.md");
    assert!(f.project.join(&file).as_os_str().len() > 300);

    f.root.create_dir(&rel(&folder)).expect("folders");
    let stamp = f
        .root
        .write(&rel(&file), b"deep", Expect::New)
        .expect("write");
    let stamp = f
        .root
        .write(&rel(&file), b"deeper", Expect::Unchanged(stamp))
        .expect("replace");
    let (bytes, read_stamp) = f.root.read(&rel(&file), MAX).expect("read");

    assert_eq!(bytes, b"deeper");
    assert_eq!(read_stamp, stamp);
}

#[test]
fn roots_compare_without_case() {
    let f = fixture();
    let upper = PathBuf::from(f.project.to_string_lossy().to_uppercase());
    fs::write(f.project.join("idea.md"), b"x").expect("write");

    assert!(same_path(&upper, &f.project).expect("compare"));
    assert!(f.root.contains(&upper.join("IDEA.MD")).expect("compare"));
    assert!(!f.root.contains(&f.outside).expect("compare"));
    assert!(!same_path(&f.project, &f.outside).expect("compare"));
    assert!(is_inside(
        Path::new(r"\\?\C:\Users\Me\Project"),
        Path::new(r"\\?\c:\users\ME\project\Notes\Ä.md")
    ));
    assert!(!is_inside(
        Path::new(r"\\?\C:\Users\Me\Project"),
        Path::new(r"\\?\C:\Users\Me\Project2\note.md")
    ));
}

#[test]
#[ignore = "needs the right to create symbolic links; runs in CI"]
fn a_file_symlink_inside_the_project_is_written_through() {
    let f = fixture();
    fs::write(f.project.join("real.md"), b"old").expect("write");
    std::os::windows::fs::symlink_file(f.project.join("real.md"), f.project.join("link.md"))
        .expect("symbolic link");

    let (_, stamp) = f.root.read(&rel("link.md"), MAX).expect("read");
    f.root
        .write(&rel("link.md"), b"new", Expect::Unchanged(stamp))
        .expect("write");

    assert_eq!(fs::read(f.project.join("real.md")).expect("file"), b"new");
    assert!(
        fs::symlink_metadata(f.project.join("link.md"))
            .expect("link")
            .is_symlink()
    );
}

#[test]
#[ignore = "needs the right to create symbolic links; runs in CI"]
fn symlinks_out_of_the_project_are_refused() {
    let f = fixture();
    fs::write(f.outside.join("secret.txt"), b"secret").expect("write");
    std::os::windows::fs::symlink_file(f.outside.join("secret.txt"), f.project.join("secret.md"))
        .expect("symbolic link");
    std::os::windows::fs::symlink_dir(&f.outside, f.project.join("escape")).expect("symbolic link");

    let file = f.root.read(&rel("secret.md"), MAX).unwrap_err();
    let folder = f
        .root
        .write(&rel("escape/new.md"), b"x", Expect::New)
        .unwrap_err();

    assert!(matches!(file, FsError::OutsideRoot), "{file:?}");
    assert!(matches!(folder, FsError::OutsideRoot), "{folder:?}");
    assert!(!f.outside.join("new.md").exists());
}
