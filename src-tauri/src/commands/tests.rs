use std::{io, path::PathBuf};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::projects::{CurrentProject, ProjectStatus, Workspace, checked};
use super::settings::SettingsView;
use super::*;
use crate::domain::projects::ProjectError;
use crate::domain::settings::{SettingKey, Settings};
use crate::frame::FrameStyle;
use crate::storage::db::Kind;
use crate::storage::fs::{FsError, PathRule};
use crate::test_support::{
    Snapshot, TreeSnapshot, app_data, current, damage, liurium_database, project, temp_dir,
};
use crate::theme::{Mode, ThemeChoice};

fn to_json(value: &impl Serialize) -> Value {
    serde_json::to_value(value).expect("serializable")
}

#[test]
fn errors_cross_ipc_as_a_kind_with_camel_case_fields() {
    assert_eq!(
        to_json(&CommandError::Changed),
        json!({ "kind": "changed" })
    );
    assert_eq!(
        to_json(&CommandError::NewerVersion),
        json!({ "kind": "newerVersion" })
    );
    assert_eq!(
        to_json(&CommandError::TooLarge { max_bytes: 10 }),
        json!({ "kind": "tooLarge", "maxBytes": 10 })
    );
}

#[test]
fn database_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (DbError::Missing, CommandError::NotFound),
        (DbError::NotLiurium, CommandError::Damaged),
        (DbError::Corrupt, CommandError::Damaged),
        (
            DbError::NewerSchema {
                found: 3,
                supported: 1,
            },
            CommandError::NewerVersion,
        ),
        (DbError::Locked, CommandError::Locked),
        (DbError::DiskFull, CommandError::DiskFull),
        (DbError::ReadOnly, CommandError::ReadOnly),
        (
            DbError::Migration {
                version: 2,
                source: rusqlite::Error::InvalidQuery,
            },
            CommandError::UpgradeFailed,
        ),
        (
            DbError::JournalMode {
                wanted: "wal",
                got: "delete".into(),
            },
            CommandError::Internal,
        ),
        (
            DbError::Sqlite(rusqlite::Error::InvalidQuery),
            CommandError::Internal,
        ),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

#[test]
fn file_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (
            FsError::InvalidPath(PathRule::Reserved),
            CommandError::InvalidPath,
        ),
        (FsError::OutsideRoot, CommandError::OutsideProject),
        (FsError::Protected, CommandError::Protected),
        (FsError::BrokenLink, CommandError::BrokenLink),
        (FsError::NotFound, CommandError::NotFound),
        (FsError::WrongKind, CommandError::WrongKind),
        (FsError::AlreadyExists, CommandError::AlreadyExists),
        (FsError::Changed, CommandError::Changed),
        (FsError::ReadOnly, CommandError::ReadOnly),
        (
            FsError::TooLarge { len: 20, max: 10 },
            CommandError::TooLarge { max_bytes: 10 },
        ),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

#[test]
fn operating_system_details_never_cross_ipc() {
    let secret = r"C:\Users\Someone\notes\diary.md: access denied";
    let file = CommandError::from(FsError::Io(io::Error::other(secret)));
    let database = CommandError::from(DbError::Io(io::Error::other(secret)));

    for error in [file, database] {
        assert_eq!(to_json(&error), json!({ "kind": "internal" }));
    }
}

#[test]
fn a_new_app_folder_is_ready() {
    let dir = temp_dir();
    let startup = Startup::open(Some(&dir.path().join("app")));

    assert_eq!(startup.data, DataStatus::Ready);
    assert!(dir.path().join(r"app\app.db").is_file());
}

#[test]
fn a_damaged_app_database_is_reported_as_recovered() {
    let dir = temp_dir();
    let path = dir.path().join("app.db");
    drop(liurium_database(&path, Kind::App, current(Kind::App)));
    damage(&path);

    let startup = Startup::open(Some(dir.path()));

    assert_eq!(startup.data, DataStatus::Recovered);
}

#[test]
fn a_newer_app_database_is_reported_as_failed() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    Connection::open(&path)
        .expect("database")
        .pragma_update(None, "user_version", 9)
        .expect("version");
    let before = Snapshot::of(&path);

    let startup = Startup::open(Some(dir.path()));
    before.assert_unchanged(&path);

    assert_eq!(
        to_json(&startup.data),
        json!({ "state": "failed", "error": { "kind": "newerVersion" } })
    );
}

#[test]
fn a_missing_app_folder_path_is_an_internal_failure() {
    assert_eq!(
        Startup::open(None).data,
        DataStatus::Failed {
            error: CommandError::Internal
        }
    );
}

#[test]
fn app_info_uses_camel_case_names() {
    let info = AppInfo {
        version: "0.1.0".into(),
        data: DataStatus::Recovered,
    };
    assert_eq!(
        to_json(&info),
        json!({ "version": "0.1.0", "data": { "state": "recovered" } })
    );
}

#[test]
fn project_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (ProjectError::Fs(FsError::ReadOnly), CommandError::ReadOnly),
        (ProjectError::Db(DbError::Locked), CommandError::Locked),
        (ProjectError::Unsuitable, CommandError::UnsuitableFolder),
        (ProjectError::Damaged, CommandError::Damaged),
        (ProjectError::Unknown, CommandError::NotFound),
        (ProjectError::OtherProject, CommandError::OtherProject),
        (ProjectError::Duplicate, CommandError::DuplicateProject),
        (ProjectError::NoProject, CommandError::NoProject),
        (ProjectError::InvalidName, CommandError::InvalidName),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

fn workspace(app_dir: &Path) -> Workspace {
    let startup = Startup::open(Some(app_dir));
    Workspace::new(Some(app_dir.to_owned()), &startup.data)
}

#[test]
fn a_first_start_has_no_current_project() {
    let dir = temp_dir();

    let current = workspace(&dir.path().join("app"))
        .current()
        .expect("current");

    assert_eq!(to_json(&current), json!({ "state": "none" }));
}

#[test]
fn the_added_project_opens_again_after_a_restart() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    let added = workspace(&app_dir).add(&fixture.root).expect("added");

    let restarted = workspace(&app_dir).current().expect("current");

    assert_eq!(added.id, fixture.id);
    assert_eq!(
        restarted,
        CurrentProject::Open {
            project: added.clone()
        }
    );
    // The long path without `\\?\`: CI's temp folder is a short 8.3 name.
    let long = std::fs::canonicalize(&fixture.root).expect("folder");
    assert_eq!(
        to_json(&added)["folder"],
        json!(long.to_string_lossy().trim_start_matches(r"\\?\"))
    );
    assert_eq!(to_json(&added)["readOnly"], json!(false));
}

#[test]
fn a_project_that_cannot_be_reopened_is_named_with_the_reason() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    workspace(&app_dir).add(&fixture.root).expect("added");
    std::fs::remove_dir_all(&fixture.root).expect("folder gone");

    let restarted = workspace(&app_dir).current().expect("current");

    assert_eq!(
        to_json(&restarted),
        json!({
            "state": "unavailable",
            "id": fixture.id,
            "name": "Garden",
            "error": { "kind": "notFound" }
        })
    );
}

fn statuses(workspace: &Workspace) -> Vec<(String, ProjectStatus)> {
    workspace
        .list()
        .expect("list")
        .into_iter()
        .map(|entry| (entry.name, entry.status))
        .collect()
}

#[test]
fn the_list_marks_the_open_and_the_missing_projects() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    // Names in the same order as the opening times, which can share a millisecond.
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let notes = project(dir.path(), "Notes", current(Kind::Project));
    let old = project(dir.path(), "Old", current(Kind::Project));
    let workspace = workspace(&app_dir);
    for fixture in [&old, &notes, &garden] {
        workspace.add(&fixture.root).expect("added");
    }
    std::fs::rename(&old.root, dir.path().join("Moved")).expect("move");

    // A fresh workspace, as after a restart, that lists before anything else.
    let restarted = statuses(&self::workspace(&app_dir));

    assert_eq!(
        restarted,
        [
            ("Garden".to_owned(), ProjectStatus::Open),
            ("Notes".to_owned(), ProjectStatus::Available),
            ("Old".to_owned(), ProjectStatus::Missing),
        ]
    );
    let entry = &workspace.list().expect("list")[0];
    assert_eq!(
        to_json(entry)
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>()),
        Some(vec![
            "folder".to_owned(),
            "id".to_owned(),
            "lastOpenedAt".to_owned(),
            "name".to_owned(),
            "status".to_owned()
        ])
    );
    assert_eq!(to_json(&entry.status), json!("open"));
}

#[test]
fn opening_another_project_makes_it_the_open_one() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    workspace.add(&garden.root).expect("added");
    workspace.add(&work.root).expect("added");

    let opened = workspace.open(&garden.id).expect("opened");

    assert_eq!(opened.name, "Garden");
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: opened }
    );
    assert_eq!(
        statuses(&workspace)[0],
        ("Garden".to_owned(), ProjectStatus::Open)
    );
}

#[test]
fn a_project_that_fails_to_open_leaves_the_open_one_open() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    workspace.add(&garden.root).expect("added");
    let open = workspace.add(&work.root).expect("added");
    std::fs::remove_dir_all(&garden.root).expect("gone");

    assert_eq!(workspace.open(&garden.id), Err(CommandError::NotFound));
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: open }
    );
}

#[test]
fn renaming_the_open_project_updates_what_the_page_is_shown() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    workspace.add(&work.root).expect("added");
    workspace.add(&garden.root).expect("added");

    workspace
        .rename(&garden.id, "Kitchen")
        .expect("renamed open");
    workspace
        .rename(&work.id, "Office")
        .expect("renamed closed");

    let CurrentProject::Open { project } = workspace.current().expect("current") else {
        panic!("a project is open");
    };
    assert_eq!(project.name, "Kitchen");
    assert_eq!(
        statuses(&workspace),
        [
            ("Kitchen".to_owned(), ProjectStatus::Open),
            ("Office".to_owned(), ProjectStatus::Available)
        ]
    );
    assert_eq!(
        workspace.rename(&work.id, " "),
        Err(CommandError::InvalidName)
    );
}

#[test]
fn removing_the_open_project_closes_it_and_keeps_its_folder() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    workspace.add(&work.root).expect("added");
    workspace.add(&garden.root).expect("added");

    workspace.remove(&work.id).expect("removed closed");
    assert!(matches!(
        workspace.current().expect("current"),
        CurrentProject::Open { .. }
    ));
    let before = TreeSnapshot::of(&garden.root);
    workspace.remove(&garden.id).expect("removed open");

    assert_eq!(workspace.current().expect("current"), CurrentProject::None);
    assert!(workspace.list().expect("list").is_empty());
    before.assert_unchanged(&garden.root);
    assert_eq!(workspace.remove(&garden.id), Err(CommandError::NotFound));
}

#[test]
fn a_located_project_becomes_the_open_one() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    workspace(&app_dir).add(&garden.root).expect("added");
    let moved = dir.path().join("Moved");
    std::fs::rename(&garden.root, &moved).expect("move");
    let workspace = workspace(&app_dir);
    assert!(matches!(
        workspace.current().expect("current"),
        CurrentProject::Unavailable { .. }
    ));

    let located = workspace.locate(&garden.id, &moved).expect("located");

    assert_eq!(located.id, garden.id);
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: located }
    );
    assert_eq!(
        statuses(&workspace),
        [("Garden".to_owned(), ProjectStatus::Open)]
    );
}

#[test]
fn ids_from_the_page_must_be_project_ids() {
    assert_eq!(
        checked("00000000-0000-4000-8000-000000000001"),
        Ok("00000000-0000-4000-8000-000000000001")
    );
    for bad in [
        "",
        "..",
        r"C:\Users",
        "00000000-0000-4000-8000-00000000000Z",
    ] {
        assert_eq!(checked(bad), Err(CommandError::NotFound), "{bad}");
    }
}

fn stored_settings(app_dir: &Path) -> Settings {
    let conn =
        db::open(&app_dir.join("app.db"), Kind::App, db::OpenMode::Existing).expect("app.db");
    stored::load(&conn).expect("settings").settings
}

const CHOSEN: Settings = Settings {
    theme: ThemeChoice::Mint,
    mode: Mode::Dark,
    frame: FrameStyle::Native,
};

#[test]
fn the_start_reads_the_stored_settings() {
    let dir = temp_dir();
    app_data(dir.path(), &[]);
    stored::save(
        &mut db::open(
            &dir.path().join("app.db"),
            Kind::App,
            db::OpenMode::Existing,
        )
        .expect("app.db"),
        &CHOSEN,
    )
    .expect("save");

    let startup = Startup::open(Some(dir.path()));

    assert_eq!(startup.settings.settings, CHOSEN);
    assert!(startup.settings.fell_back.is_empty());
}

#[test]
fn without_app_data_the_start_uses_the_default_settings() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    Connection::open(&path)
        .expect("database")
        .pragma_update(None, "user_version", 9)
        .expect("version");

    assert_eq!(Startup::open(Some(dir.path())).settings, Loaded::default());
    assert_eq!(Startup::open(None).settings, Loaded::default());
}

#[test]
fn updating_saves_applies_and_forgets_old_fallbacks() {
    let dir = temp_dir();
    let workspace = workspace(dir.path());
    let preferences = Preferences::new(Loaded {
        settings: Settings::default(),
        fell_back: vec![SettingKey::Theme],
    });
    let mut applied = None;

    let view = preferences
        .update(CHOSEN, &workspace, |settings| applied = Some(*settings))
        .expect("update");

    assert_eq!(applied, Some(CHOSEN));
    assert_eq!(
        view,
        SettingsView {
            settings: CHOSEN,
            frame_at_start: FrameStyle::Liurium,
            fell_back: Vec::new(),
        }
    );
    assert_eq!(preferences.settings(), CHOSEN);
    assert_eq!(stored_settings(dir.path()), CHOSEN);
}

#[test]
fn a_failed_save_applies_nothing() {
    let failed = DataStatus::Failed {
        error: CommandError::NewerVersion,
    };
    let workspace = Workspace::new(Some(PathBuf::from("unused")), &failed);
    let preferences = Preferences::new(Loaded::default());
    let mut applied = false;

    let result = preferences.update(CHOSEN, &workspace, |_| applied = true);

    assert_eq!(result, Err(CommandError::NewerVersion));
    assert!(!applied);
    assert_eq!(preferences.settings(), Settings::default());
}

#[test]
fn settings_from_the_page_must_be_allowed_values() {
    let valid = json!({ "theme": "mint-graphite", "mode": "light", "frame": "hidden" });
    assert!(serde_json::from_value::<Settings>(valid).is_ok());
    for invalid in [
        json!({ "theme": "violet", "mode": "light", "frame": "hidden" }),
        json!({ "theme": "mint", "mode": "auto", "frame": "hidden" }),
        json!({ "theme": "mint", "mode": "light", "frame": "frameless" }),
        json!({ "theme": "mint", "mode": "light" }),
        json!({ "theme": "mint", "mode": "light", "frame": "hidden", "path": "C:\\" }),
    ] {
        assert!(
            serde_json::from_value::<Settings>(invalid.clone()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn the_settings_view_uses_camel_case_names() {
    let view = Preferences::new(Loaded {
        settings: CHOSEN,
        fell_back: vec![SettingKey::Mode],
    })
    .view()
    .expect("view");

    assert_eq!(
        to_json(&view),
        json!({
            "settings": { "theme": "mint", "mode": "dark", "frame": "native" },
            "frameAtStart": "native",
            "fellBack": ["mode"],
        })
    );
}

#[test]
fn without_app_data_project_commands_report_why() {
    let failed = DataStatus::Failed {
        error: CommandError::NewerVersion,
    };
    let workspace = Workspace::new(Some(PathBuf::from("unused")), &failed);

    assert_eq!(workspace.current(), Err(CommandError::NewerVersion));
    assert_eq!(
        workspace.add(Path::new("unused")),
        Err(CommandError::NewerVersion)
    );
    let id = "00000000-0000-4000-8000-000000000001";
    assert_eq!(workspace.list(), Err(CommandError::NewerVersion));
    assert_eq!(workspace.open(id), Err(CommandError::NewerVersion));
    assert_eq!(workspace.rename(id, "x"), Err(CommandError::NewerVersion));
    assert_eq!(workspace.remove(id), Err(CommandError::NewerVersion));
    assert_eq!(
        workspace.locate(id, Path::new("unused")),
        Err(CommandError::NewerVersion)
    );
}
