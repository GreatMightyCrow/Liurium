use std::{fs, io};

use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;
use crate::storage::fs::{FsError, PathRule};

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
    let dir = TempDir::new().expect("temp folder");
    let startup = Startup::open(Some(&dir.path().join("app")));

    assert_eq!(startup.data, DataStatus::Ready);
    assert!(dir.path().join(r"app\app.db").is_file());
}

#[test]
fn a_damaged_app_database_is_reported_as_recovered() {
    let dir = TempDir::new().expect("temp folder");
    fs::write(dir.path().join("app.db"), b"not a database").expect("write");

    let startup = Startup::open(Some(dir.path()));

    assert_eq!(startup.data, DataStatus::Recovered);
}

#[test]
fn a_newer_app_database_is_reported_as_failed() {
    let dir = TempDir::new().expect("temp folder");
    let app = db::open_app(dir.path()).expect("app database");
    app.connection
        .pragma_update(None, "user_version", 9)
        .expect("version");
    drop(app);

    let startup = Startup::open(Some(dir.path()));

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
