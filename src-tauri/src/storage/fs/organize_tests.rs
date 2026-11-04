//! Creating, renaming, moving, and trashing in real temp folders (M3-004). Junction
//! tests run everywhere; symbolic link tests need the right and run in CI.

use std::time::{Duration, UNIX_EPOCH};

use tempfile::TempDir;

use super::*;
use crate::test_support::{Snapshot, TreeSnapshot, junction, temp_dir};

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
    fs::create_dir_all(project.join(LIURIUM_DIR)).expect("project");
    fs::write(project.join(LIURIUM_DIR).join(".gitignore"), "backups/\n").expect("gitignore");
    fs::create_dir(&outside).expect("outside");
    let root = ProjectRoot::open(&project).expect("root");
    Fixture {
        _dir: dir,
        project,
        outside,
        root,
    }
}

impl Fixture {
    fn file(&self, rel: &str, text: &str) {
        let path = self.project.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("folders");
        fs::write(path, text).expect("file");
    }

    fn text(&self, rel: &str) -> String {
        fs::read_to_string(self.project.join(rel)).expect("file")
    }

    fn gitignore(&self) -> String {
        fs::read_to_string(self.project.join(LIURIUM_DIR).join(".gitignore")).expect("gitignore")
    }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

#[test]
fn a_folder_is_created_once_and_never_over_anything() {
    let f = fixture();
    f.root.create_folder(&rel("Ideas")).expect("created");
    assert!(f.project.join("Ideas").is_dir());

    assert!(matches!(
        f.root.create_folder(&rel("Ideas")).unwrap_err(),
        FsError::AlreadyExists
    ));
    assert!(matches!(
        f.root.create_folder(&rel("missing/inner")).unwrap_err(),
        FsError::NotFound
    ));
    for path in [".liurium", ".git"] {
        let error = f.root.create_folder(&rel(path)).unwrap_err();
        assert!(matches!(error, FsError::Protected), "{path}: {error:?}");
    }
}

#[test]
fn a_note_is_renamed_and_moved_but_never_over_another() {
    let f = fixture();
    f.file("Plan.md", "plan");
    f.file("Other.md", "other");
    f.file("Ideas/Keep.md", "keep");
    let before = Snapshot::of(&f.project.join("Other.md"));

    let error = f
        .root
        .rename(&rel("Plan.md"), &rel("Other.md"))
        .unwrap_err();
    assert!(matches!(error, FsError::AlreadyExists), "{error:?}");
    let error = f
        .root
        .rename(&rel("Plan.md"), &rel("other.md"))
        .unwrap_err();
    assert!(matches!(error, FsError::AlreadyExists), "case: {error:?}");
    before.assert_unchanged(&f.project.join("Other.md"));
    assert_eq!(f.text("Plan.md"), "plan");

    f.root
        .rename(&rel("Plan.md"), &rel("Renamed.md"))
        .expect("rename");
    f.root
        .rename(&rel("Renamed.md"), &rel("Ideas/Renamed.md"))
        .expect("move");

    assert!(!f.project.join("Plan.md").exists());
    assert_eq!(f.text("Ideas/Renamed.md"), "plan");
    assert_eq!(f.text("Ideas/Keep.md"), "keep");
}

#[test]
fn a_change_of_case_only_is_allowed() {
    let f = fixture();
    f.file("plan.md", "plan");

    f.root
        .rename(&rel("plan.md"), &rel("Plan.md"))
        .expect("rename");

    let names: Vec<String> = fs::read_dir(&f.project)
        .expect("folder")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains(&"Plan.md".to_owned()), "{names:?}");
    assert!(!names.contains(&"plan.md".to_owned()), "{names:?}");
}

#[test]
fn a_folder_moves_with_its_contents_but_not_into_itself() {
    let f = fixture();
    f.file("Ideas/a.md", "a");
    f.file("Ideas/Deep/b.md", "b");
    f.root.create_folder(&rel("Archive")).expect("folder");

    for target in ["Ideas/Inside", "Ideas/Deep/Inside"] {
        let error = f.root.rename(&rel("Ideas"), &rel(target)).unwrap_err();
        assert!(matches!(error, FsError::IntoItself), "{target}: {error:?}");
    }
    f.root
        .rename(&rel("Ideas"), &rel("Archive/Ideas"))
        .expect("move");

    assert_eq!(f.text("Archive/Ideas/a.md"), "a");
    assert_eq!(f.text("Archive/Ideas/Deep/b.md"), "b");
}

#[test]
fn links_and_junctions_are_not_renamed_moved_or_trashed() {
    let f = fixture();
    f.file("notes/a.md", "a");
    fs::write(f.outside.join("secret.md"), "secret").expect("file");
    junction(&f.project.join("alias"), &f.project.join("notes"));
    junction(&f.project.join("escape"), &f.outside);
    let before = TreeSnapshot::of(&f.project);

    for path in ["alias", "escape"] {
        let renamed = f.root.rename(&rel(path), &rel("renamed")).unwrap_err();
        let trashed = f.root.trash(&rel(path)).unwrap_err();
        assert!(matches!(renamed, FsError::IsLink), "{path}: {renamed:?}");
        assert!(matches!(trashed, FsError::IsLink), "{path}: {trashed:?}");
    }
    // Through a junction that leads outside, nothing can be reached either.
    let through = f
        .root
        .rename(&rel("escape/secret.md"), &rel("stolen.md"))
        .unwrap_err();
    assert!(matches!(through, FsError::OutsideRoot), "{through:?}");

    before.assert_unchanged(&f.project);
    assert_eq!(
        fs::read_to_string(f.outside.join("secret.md")).expect("secret"),
        "secret"
    );
}

#[test]
fn nothing_moves_into_or_out_of_liurium_and_git() {
    let f = fixture();
    f.file("a.md", "a");
    f.file(".git/config", "git");

    for (from, to) in [
        ("a.md", ".liurium/a.md"),
        ("a.md", ".git/a.md"),
        (".git/config", "config.md"),
        (".liurium/.gitignore", "x.md"),
    ] {
        let error = f.root.rename(&rel(from), &rel(to)).unwrap_err();
        assert!(
            matches!(error, FsError::Protected),
            "{from} -> {to}: {error:?}"
        );
    }
    for path in [".liurium", ".git"] {
        let error = f.root.trash(&rel(path)).unwrap_err();
        assert!(matches!(error, FsError::Protected), "{path}: {error:?}");
    }
    assert_eq!(f.text("a.md"), "a");
}

#[test]
fn trashing_moves_the_item_under_liurium_trash_and_ignores_it_in_git() {
    let f = fixture();
    f.file("Ideas/Plan.md", "plan");
    f.file("Old/a.md", "a");
    f.file("Old/Deep/b.md", "b");

    let note = f.root.trash(&rel("Ideas/Plan.md")).expect("trash note");
    let folder = f.root.trash(&rel("Old")).expect("trash folder");

    assert!(!f.project.join("Ideas/Plan.md").exists());
    assert!(f.project.join("Ideas").is_dir(), "the parent folder stays");
    assert!(!f.project.join("Old").exists());
    assert_eq!(fs::read_to_string(&note).expect("trashed"), "plan");
    assert!(note.ends_with(Path::new("Ideas").join("Plan.md")));
    assert_eq!(
        fs::read_to_string(folder.join("Deep").join("b.md")).expect("trashed"),
        "b"
    );
    let trash = fs::canonicalize(f.project.join(LIURIUM_DIR).join(TRASH_DIR)).expect("trash");
    assert!(note.starts_with(&trash), "{note:?}");
    assert!(folder.starts_with(&trash), "{folder:?}");
    let gitignore = f.gitignore();
    assert!(gitignore.starts_with("backups/\n"), "{gitignore}");
    assert_eq!(gitignore.matches("trash/").count(), 1);

    f.file("c.md", "c");
    f.root.trash(&rel("c.md")).expect("again");
    assert_eq!(f.gitignore(), gitignore, "the line is added once");
}

#[test]
fn utc_stamps_name_the_date_and_time() {
    assert_eq!(utc_stamp(UNIX_EPOCH), "19700101T000000Z");
    let time = UNIX_EPOCH + Duration::from_secs(1_793_738_130);
    assert_eq!(utc_stamp(time), "20261103T203530Z");
    let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
    assert_eq!(utc_stamp(leap), "20000229T000000Z");
}

#[test]
#[ignore = "needs the right to create symbolic links; runs in CI"]
fn symbolic_links_are_not_renamed_or_trashed() {
    let f = fixture();
    f.file("real.md", "real");
    std::os::windows::fs::symlink_file(f.project.join("real.md"), f.project.join("link.md"))
        .expect("link");

    let renamed = f
        .root
        .rename(&rel("link.md"), &rel("other.md"))
        .unwrap_err();
    let trashed = f.root.trash(&rel("link.md")).unwrap_err();

    assert!(matches!(renamed, FsError::IsLink), "{renamed:?}");
    assert!(matches!(trashed, FsError::IsLink), "{trashed:?}");
    assert_eq!(f.text("real.md"), "real");
}
