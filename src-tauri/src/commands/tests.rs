use std::{io, path::PathBuf};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::projects::{CurrentProject, Workspace};
use super::*;
use crate::domain::projects::ProjectError;
use crate::storage::db::Kind;
use crate::storage::fs::{FsError, PathRule};
use crate::test_support::{
    Snapshot, app_data, current, damage, liurium_database, project, temp_dir,
};

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
        json!({ "state": "unavailable", "name": "Garden", "error": { "kind": "notFound" } })
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
}
