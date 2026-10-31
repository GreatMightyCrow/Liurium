use std::fs;

use rusqlite::Connection;

use super::*;
use crate::storage::{db::DbError, fs::FsError};
use crate::test_support::{Snapshot, current, deny_writes, junction, project, read_only, temp_dir};

/// A fresh `app.db` in its own temp folder.
fn app(dir: &Path) -> Connection {
    db::open_app(&dir.join("app"))
        .expect("app database")
        .connection
}

fn registered(app: &Connection) -> Vec<(String, String)> {
    app.prepare("SELECT id, path FROM projects ORDER BY path")
        .expect("query")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("registry")
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .expect("folder")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

/// A name `create_temp` could have made.
const TEMP: &str = ".1a2b-0-3c4d.liurium-tmp";

#[test]
fn adding_an_empty_folder_creates_the_project_and_registers_it() {
    let dir = temp_dir();
    let app = app(dir.path());
    let folder = dir.path().join("Garden");
    fs::create_dir(&folder).expect("folder");

    let project = add(&app, &folder).expect("added");

    assert!(is_project_id(&project.id), "{}", project.id);
    assert_eq!(project.name, "Garden");
    assert!(!project.read_only);
    assert_eq!(
        names_in(&folder.join(LIURIUM_DIR)),
        [".gitignore", "project.db"]
    );
    let gitignore = fs::read_to_string(folder.join(LIURIUM_DIR).join(".gitignore")).unwrap();
    assert!(gitignore.contains("backups/") && !gitignore.contains("project.db\n"));
    assert_eq!(
        registered(&app),
        [(project.id.clone(), project.root.display())]
    );
    assert_eq!(
        last_opened(&app).unwrap(),
        Some((project.id.clone(), "Garden".to_owned()))
    );
}

#[test]
fn a_project_opens_again_with_the_same_identity() {
    let dir = temp_dir();
    let app = app(dir.path());
    let folder = dir.path().join("Garden");
    fs::create_dir(&folder).expect("folder");
    let id = add(&app, &folder).expect("added").id;

    let again = open(&app, &id).expect("opened");

    assert_eq!(again.id, id);
    assert_eq!(again.name, "Garden");
}

#[test]
fn adding_a_folder_with_notes_only_adds_liurium() {
    let dir = temp_dir();
    let app = app(dir.path());
    let folder = dir.path().join("Notes");
    fs::create_dir_all(folder.join("daily")).expect("folders");
    fs::write(folder.join("readme.md"), "# Notes\n").expect("note");
    fs::write(folder.join("daily").join("monday.md"), "- [ ] plan\n").expect("note");
    let readme = Snapshot::of(&folder.join("readme.md"));
    let monday = Snapshot::of(&folder.join("daily").join("monday.md"));

    add(&app, &folder).expect("added");

    assert_eq!(names_in(&folder), [LIURIUM_DIR, "daily", "readme.md"]);
    assert_eq!(names_in(&folder.join("daily")), ["monday.md"]);
    readme.assert_unchanged(&folder.join("readme.md"));
    monday.assert_unchanged(&folder.join("daily").join("monday.md"));
}

#[test]
fn an_existing_project_keeps_its_identity_and_is_not_rewritten() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Existing", current(Kind::Project));
    let before = Snapshot::of(&fixture.database());

    let project = add(&app, &fixture.root).expect("adopted");

    assert_eq!(project.id, fixture.id);
    assert_eq!(project.name, "Existing");
    drop(project);
    before.assert_unchanged(&fixture.database());
    assert!(!fixture.root.join(LIURIUM_DIR).join(".gitignore").exists());
}

#[test]
fn an_empty_liurium_folder_is_filled_and_kept() {
    let dir = temp_dir();
    let app = app(dir.path());
    let folder = dir.path().join("Half");
    fs::create_dir_all(folder.join(LIURIUM_DIR)).expect("folders");
    fs::write(folder.join(LIURIUM_DIR).join(".gitignore"), "mine\n").expect("own file");

    add(&app, &folder).expect("added");

    assert_eq!(
        fs::read_to_string(folder.join(LIURIUM_DIR).join(".gitignore")).unwrap(),
        "mine\n",
        "an existing .gitignore is never replaced"
    );
    assert!(folder.join(LIURIUM_DIR).join(PROJECT_DB).exists());
}

#[test]
fn a_project_from_a_newer_liurium_is_refused_and_left_alone() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Future", current(Kind::Project));
    Connection::open(fixture.database())
        .and_then(|conn| conn.pragma_update(None, "user_version", 99))
        .expect("newer version");
    let before = Snapshot::of(&fixture.database());

    let error = add(&app, &fixture.root).unwrap_err();

    assert!(
        matches!(error, ProjectError::Db(DbError::NewerSchema { .. })),
        "{error:?}"
    );
    before.assert_unchanged(&fixture.database());
    assert!(registered(&app).is_empty());
}

#[test]
fn a_project_without_a_valid_id_is_damaged() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "NoId", current(Kind::Project));
    Connection::open(fixture.database())
        .and_then(|conn| conn.execute("UPDATE meta SET value = '../x' WHERE key = 'id'", []))
        .expect("bad id");

    let error = add(&app, &fixture.root).unwrap_err();

    assert!(matches!(error, ProjectError::Damaged), "{error:?}");
    assert!(registered(&app).is_empty());
}

#[test]
fn missing_and_file_paths_are_refused() {
    let dir = temp_dir();
    let app = app(dir.path());
    let file = dir.path().join("note.md");
    fs::write(&file, "x").expect("file");

    let missing = add(&app, &dir.path().join("gone")).unwrap_err();
    let not_a_folder = add(&app, &file).unwrap_err();

    assert!(
        matches!(missing, ProjectError::Fs(FsError::NotFound)),
        "{missing:?}"
    );
    assert!(
        matches!(not_a_folder, ProjectError::Fs(FsError::WrongKind)),
        "{not_a_folder:?}"
    );
}

#[test]
fn drives_and_folders_inside_liurium_or_git_are_unsuitable() {
    let dir = temp_dir();
    let app = app(dir.path());
    let drive = dir.path().ancestors().last().expect("drive root");
    let inside_git = dir.path().join("repo").join(".git").join("hooks");
    fs::create_dir_all(&inside_git).expect("folders");

    for folder in [drive, inside_git.as_path()] {
        let error = add(&app, folder).unwrap_err();
        assert!(
            matches!(error, ProjectError::Unsuitable),
            "{folder:?}: {error:?}"
        );
    }
    assert!(!inside_git.join(LIURIUM_DIR).exists());
}

#[test]
fn a_folder_without_write_access_is_refused_without_traces() {
    let dir = temp_dir();
    let app = app(dir.path());
    let folder = dir.path().join("Locked");
    fs::create_dir(&folder).expect("folder");
    let guard = deny_writes(&folder);

    let error = add(&app, &folder).unwrap_err();

    drop(guard);
    assert!(
        matches!(error, ProjectError::Fs(FsError::ReadOnly)),
        "{error:?}"
    );
    assert!(names_in(&folder).is_empty());
    assert!(registered(&app).is_empty());
}

#[test]
fn a_write_protected_project_opens_read_only_and_writes_nothing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Archive", current(Kind::Project));
    fs::write(fixture.root.join(TEMP), "left over").expect("temp file");
    read_only(&fixture.database());
    let before = Snapshot::of(&fixture.database());

    let project = add(&app, &fixture.root).expect("opened");

    assert!(project.read_only);
    drop(project);
    before.assert_unchanged(&fixture.database());
    assert!(
        fixture.root.join(TEMP).exists(),
        "no clean-up in a read-only project"
    );
}

#[test]
fn opening_removes_only_temp_files_of_interrupted_writes() {
    let dir = temp_dir();
    let app = app(dir.path());
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).expect("folder");
    fs::write(outside.join(TEMP), "not ours").expect("file");
    let folder = dir.path().join("Work");
    fs::create_dir_all(folder.join("sub")).expect("folders");
    fs::create_dir_all(folder.join(".git")).expect("folders");
    for path in [
        folder.join(TEMP),
        folder.join("sub").join(TEMP),
        folder.join(".git").join(TEMP),
        folder.join("notes.liurium-tmp"),
        folder.join(".draft.liurium-tmp"),
    ] {
        fs::write(path, "x").expect("file");
    }
    junction(&folder.join("link"), &outside);

    add(&app, &folder).expect("added");

    assert!(!folder.join(TEMP).exists());
    assert!(!folder.join("sub").join(TEMP).exists());
    assert!(folder.join(".git").join(TEMP).exists(), ".git is skipped");
    assert!(folder.join("notes.liurium-tmp").exists(), "user file kept");
    assert!(folder.join(".draft.liurium-tmp").exists(), "user file kept");
    assert!(outside.join(TEMP).exists(), "links are not followed");
}

#[test]
fn an_unknown_id_is_reported() {
    let dir = temp_dir();
    let app = app(dir.path());

    let error = open(&app, "00000000-0000-4000-8000-000000000000").unwrap_err();

    assert!(matches!(error, ProjectError::Unknown), "{error:?}");
}

#[test]
fn a_moved_project_gets_its_new_path() {
    let dir = temp_dir();
    let app = app(dir.path());
    let old = dir.path().join("Before");
    fs::create_dir(&old).expect("folder");
    let id = add(&app, &old).expect("added").id;
    let new = dir.path().join("After");
    fs::rename(&old, &new).expect("move");

    let moved = add(&app, &new).expect("added again");

    assert_eq!(moved.id, id);
    assert_eq!(registered(&app), [(id, moved.root.display())]);
}

#[test]
fn a_copied_project_is_refused() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Original", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    let copy = dir.path().join("Copy");
    fs::create_dir_all(copy.join(LIURIUM_DIR)).expect("folders");
    fs::copy(fixture.database(), copy.join(LIURIUM_DIR).join(PROJECT_DB)).expect("copy");

    let error = add(&app, &copy).unwrap_err();

    assert!(matches!(error, ProjectError::Duplicate), "{error:?}");
    assert_eq!(registered(&app).len(), 1);
}

#[test]
fn a_folder_that_now_holds_another_project_is_reported() {
    let dir = temp_dir();
    let app = app(dir.path());
    let first = project(dir.path(), "First", current(Kind::Project));
    let id = add(&app, &first.root).expect("added").id;
    let other = project(dir.path(), "Other", current(Kind::Project));
    fs::remove_dir_all(first.root.join(LIURIUM_DIR)).expect("remove");
    fs::rename(other.root.join(LIURIUM_DIR), first.root.join(LIURIUM_DIR)).expect("swap");

    let error = open(&app, &id).unwrap_err();

    assert!(matches!(error, ProjectError::OtherProject), "{error:?}");
}

#[test]
fn the_last_opened_project_is_the_newest() {
    let dir = temp_dir();
    let app = app(dir.path());
    let first = project(dir.path(), "First", current(Kind::Project));
    let second = project(dir.path(), "Second", current(Kind::Project));
    assert_eq!(last_opened(&app).unwrap(), None);
    add(&app, &first.root).expect("added");
    add(&app, &second.root).expect("added");

    open(&app, &first.id).expect("opened");

    assert_eq!(
        last_opened(&app).unwrap(),
        Some((first.id.clone(), "First".to_owned()))
    );
}

#[test]
fn a_failed_creation_removes_what_it_made() {
    let dir = temp_dir();
    let made = dir.path().join(LIURIUM_DIR);
    fs::create_dir(&made).expect("folder");
    fs::write(made.join(PROJECT_DB), "x").expect("file");
    drop(Created {
        dir: Some(made.clone()),
        files: vec![made.join(PROJECT_DB)],
    });
    assert!(!made.exists());

    let kept = dir.path().join("kept");
    fs::create_dir(&kept).expect("folder");
    fs::write(kept.join("project.db"), "x").expect("file");
    fs::write(kept.join("project.db-journal"), "x").expect("file");
    fs::write(kept.join("mine.txt"), "x").expect("file");
    drop(Created {
        dir: None,
        files: vec![kept.join("project.db")],
    });
    assert_eq!(names_in(&kept), ["mine.txt"]);
}

#[test]
fn new_ids_are_uuid_v4() {
    let dir = temp_dir();
    let conn = Connection::open(dir.path().join("x.db")).expect("db");
    let first = new_id(&conn).expect("id");
    let second = new_id(&conn).expect("id");

    assert!(is_project_id(&first), "{first}");
    assert_ne!(first, second);
    for bad in [
        "",
        "../../etc",
        "00000000-0000-1000-8000-000000000000",
        "00000000-0000-4000-c000-000000000000",
        "00000000-0000-4000-8000-00000000000G",
        "00000000-0000-4000-8000-00000000000A",
    ] {
        assert!(!is_project_id(bad), "{bad}");
    }
}

#[test]
fn names_lose_control_characters_and_length() {
    assert_eq!(clean_name("  Garden\u{0}\u{1b}[31m "), "Garden[31m");
    assert_eq!(clean_name(&"x".repeat(500)).chars().count(), MAX_NAME_CHARS);
}
