use std::fs;

use rusqlite::Connection;

use super::*;
use crate::storage::{db::DbError, fs::FsError};
use crate::test_support::{
    Snapshot, TreeSnapshot, current, deny_writes, junction, project, read_only, temp_dir,
};

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

fn ids_in(entries: &[Entry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.id.as_str()).collect()
}

fn name_in(database: &Path) -> String {
    Connection::open(database)
        .and_then(|conn| {
            conn.query_row("SELECT value FROM meta WHERE key = 'name'", [], |row| {
                row.get(0)
            })
        })
        .expect("name")
}

#[test]
fn the_list_shows_the_newest_first_and_marks_moved_folders() {
    let dir = temp_dir();
    let app = app(dir.path());
    let first = project(dir.path(), "First", current(Kind::Project));
    let second = project(dir.path(), "Second", current(Kind::Project));
    let third = project(dir.path(), "Third", current(Kind::Project));
    for fixture in [&first, &second, &third] {
        add(&app, &fixture.root).expect("added");
    }
    app.execute(
        "UPDATE projects SET last_opened_at = NULL WHERE id = ?1",
        [&third.id],
    )
    .expect("never opened");
    open(&app, &first.id).expect("opened");
    fs::rename(&second.root, dir.path().join("Elsewhere")).expect("move");

    let entries = list(&app).expect("list");

    assert_eq!(ids_in(&entries), [&first.id, &second.id, &third.id]);
    let present: Vec<bool> = entries.iter().map(|entry| entry.present).collect();
    assert_eq!(present, [true, false, true]);
    assert_eq!(entries[1].name, "Second", "the cached name stays");
    assert!(entries[2].last_opened_at.is_none());
}

#[test]
fn a_folder_that_lost_its_project_data_is_listed_as_missing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    fs::remove_dir_all(fixture.root.join(LIURIUM_DIR)).expect("data gone");

    let entries = list(&app).expect("list");

    assert!(!entries[0].present);
    assert!(fixture.root.exists());
}

#[test]
fn listing_writes_nothing_into_project_folders() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    let before = TreeSnapshot::of(&fixture.root);

    list(&app).expect("list");

    before.assert_unchanged(&fixture.root);
}

#[test]
fn renaming_writes_the_name_into_the_project_and_the_registry() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    let mut project = add(&app, &fixture.root).expect("added");

    rename(&app, &mut project, "  Kitchen garden ").expect("renamed");

    assert_eq!(project.name, "Kitchen garden");
    drop(project);
    assert_eq!(name_in(&fixture.database()), "Kitchen garden");
    assert_eq!(list(&app).expect("list")[0].name, "Kitchen garden");
    assert_eq!(
        open(&app, &fixture.id).expect("opened").name,
        "Kitchen garden"
    );
}

#[test]
fn bad_names_are_refused_and_change_nothing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    let mut project = add(&app, &fixture.root).expect("added");

    for bad in ["", "   ", "Gar\u{7}den", "Line\nbreak", &"x".repeat(201)] {
        let error = rename(&app, &mut project, bad).unwrap_err();
        assert!(
            matches!(error, ProjectError::InvalidName),
            "{bad:?}: {error:?}"
        );
    }
    rename(&app, &mut project, &"x".repeat(200)).expect("200 characters are fine");

    assert_eq!(name_in(&fixture.database()), "x".repeat(200));
}

#[test]
fn a_write_protected_project_cannot_be_renamed() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Archive", current(Kind::Project));
    read_only(&fixture.database());
    let before = Snapshot::of(&fixture.database());
    let mut project = add(&app, &fixture.root).expect("opened");

    let error = rename(&app, &mut project, "New").unwrap_err();

    assert!(
        matches!(error, ProjectError::Db(DbError::ReadOnly)),
        "{error:?}"
    );
    drop(project);
    before.assert_unchanged(&fixture.database());
    assert_eq!(list(&app).expect("list")[0].name, "Archive");
}

#[test]
fn find_loads_a_project_without_counting_it_as_opened() {
    let dir = temp_dir();
    let app = app(dir.path());
    let first = project(dir.path(), "First", current(Kind::Project));
    let second = project(dir.path(), "Second", current(Kind::Project));
    add(&app, &first.root).expect("added");
    add(&app, &second.root).expect("added");
    fs::write(first.root.join(TEMP), "left over").expect("temp file");

    let found = find(&app, &first.id).expect("found");

    assert_eq!(found.id, first.id);
    assert_eq!(
        last_opened(&app).unwrap().map(|(id, _)| id),
        Some(second.id)
    );
    assert!(
        first.root.join(TEMP).exists(),
        "no clean-up without opening"
    );
}

#[test]
fn removing_forgets_the_project_and_leaves_its_folder_byte_for_byte() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    fs::create_dir_all(fixture.root.join("daily")).expect("folder");
    fs::write(fixture.root.join("daily").join("monday.md"), "- [ ] plan\n").expect("note");
    let project = add(&app, &fixture.root).expect("added");
    drop(project);
    let before = TreeSnapshot::of(&fixture.root);

    remove(&app, &fixture.id).expect("removed");

    before.assert_unchanged(&fixture.root);
    assert!(list(&app).expect("list").is_empty());
    assert!(matches!(
        open(&app, &fixture.id).unwrap_err(),
        ProjectError::Unknown
    ));
    let again = add(&app, &fixture.root).expect("added again");
    assert_eq!(
        (again.id.as_str(), again.name.as_str()),
        (fixture.id.as_str(), "Garden")
    );
}

#[test]
fn removing_an_unknown_project_is_reported() {
    let dir = temp_dir();
    let app = app(dir.path());

    let error = remove(&app, "00000000-0000-4000-8000-000000000000").unwrap_err();

    assert!(matches!(error, ProjectError::Unknown), "{error:?}");
}

#[test]
fn a_moved_project_is_located_and_opens_with_its_data() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    let moved = dir.path().join("Moved");
    fs::rename(&fixture.root, &moved).expect("move");
    fs::write(moved.join(TEMP), "left over").expect("temp file");

    let project = locate(&app, &fixture.id, &moved).expect("located");

    assert_eq!(
        (project.id.as_str(), project.name.as_str()),
        (fixture.id.as_str(), "Garden")
    );
    assert_eq!(
        registered(&app),
        [(fixture.id.clone(), project.root.display())]
    );
    assert!(list(&app).expect("list")[0].present);
    assert!(!moved.join(TEMP).exists(), "opened like any project");
}

#[test]
fn locating_a_folder_with_another_project_changes_nothing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    fs::remove_dir_all(&fixture.root).expect("gone");
    let other = project(dir.path(), "Other", current(Kind::Project));
    fs::write(other.root.join(TEMP), "left over").expect("temp file");
    let registry = registered(&app);

    let error = locate(&app, &fixture.id, &other.root).unwrap_err();

    assert!(matches!(error, ProjectError::OtherProject), "{error:?}");
    assert_eq!(registered(&app), registry);
    assert!(other.root.join(TEMP).exists(), "nothing cleaned up");
}

#[test]
fn locating_a_folder_without_a_project_changes_nothing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    fs::remove_dir_all(&fixture.root).expect("gone");
    let plain = dir.path().join("Plain");
    fs::create_dir(&plain).expect("folder");
    fs::write(plain.join("readme.md"), "# Plain\n").expect("note");
    let empty_data = dir.path().join("EmptyData");
    fs::create_dir_all(empty_data.join(LIURIUM_DIR)).expect("folders");
    let registry = registered(&app);

    for folder in [&plain, &empty_data] {
        let before = TreeSnapshot::of(folder);
        let error = locate(&app, &fixture.id, folder).unwrap_err();
        assert!(
            matches!(error, ProjectError::NoProject),
            "{folder:?}: {error:?}"
        );
        before.assert_unchanged(folder);
    }
    assert_eq!(registered(&app), registry);
}

#[test]
fn locating_an_unknown_project_is_reported() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Garden", current(Kind::Project));

    let error = locate(&app, &fixture.id, &fixture.root).unwrap_err();

    assert!(matches!(error, ProjectError::Unknown), "{error:?}");
    assert!(registered(&app).is_empty());
}

#[test]
fn locating_a_copy_while_the_original_is_present_is_refused() {
    let dir = temp_dir();
    let app = app(dir.path());
    let fixture = project(dir.path(), "Original", current(Kind::Project));
    add(&app, &fixture.root).expect("added");
    let copy = dir.path().join("Copy");
    fs::create_dir_all(copy.join(LIURIUM_DIR)).expect("folders");
    fs::copy(fixture.database(), copy.join(LIURIUM_DIR).join(PROJECT_DB)).expect("copy");

    let error = locate(&app, &fixture.id, &copy).unwrap_err();

    assert!(matches!(error, ProjectError::Duplicate), "{error:?}");
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
