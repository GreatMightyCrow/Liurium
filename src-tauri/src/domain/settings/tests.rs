use std::path::Path;

use rusqlite::Connection;

use super::*;
use crate::storage::db::{self, Kind, OpenMode};
use crate::test_support::{app_data, read_only, temp_dir};

fn open(path: &Path) -> Connection {
    db::open(path, Kind::App, OpenMode::Existing).expect("app.db")
}

/// Stores raw text, as another version or a broken write could have left it.
fn store(path: &Path, key: &str, value: &str) {
    Connection::open(path)
        .expect("database")
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .expect("setting");
}

const CHOSEN: Settings = Settings {
    theme: ThemeChoice::MintGraphite,
    mode: Mode::Light,
    frame: FrameStyle::Hidden,
};

#[test]
fn nothing_stored_gives_the_defaults() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);

    let loaded = load(&open(&path)).expect("load");

    assert_eq!(loaded, Loaded::default());
    assert_eq!(
        loaded.settings,
        Settings {
            theme: ThemeChoice::Orange,
            mode: Mode::System,
            frame: FrameStyle::Liurium,
        }
    );
}

#[test]
fn saved_settings_load_again() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);

    save(&mut open(&path), &CHOSEN).expect("save");

    let loaded = load(&open(&path)).expect("load");
    assert_eq!(loaded.settings, CHOSEN);
    assert!(loaded.fell_back.is_empty());
}

#[test]
fn values_are_stored_as_json_under_their_names() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);

    save(&mut open(&path), &CHOSEN).expect("save");

    let conn = Connection::open(&path).expect("database");
    let mut rows: Vec<(String, String)> = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .expect("query")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("rows");
    rows.sort();
    assert_eq!(
        rows,
        [
            ("frame".to_owned(), "\"hidden\"".to_owned()),
            ("mode".to_owned(), "\"light\"".to_owned()),
            ("theme".to_owned(), "\"mint-graphite\"".to_owned()),
        ]
    );
}

#[test]
fn unreadable_values_fall_back_to_the_default_and_are_reported() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    store(&path, "theme", "\"violet\"");
    store(&path, "mode", "light");
    store(&path, "frame", "\"hidden\"");

    let loaded = load(&open(&path)).expect("load");

    assert_eq!(
        loaded.settings,
        Settings {
            frame: FrameStyle::Hidden,
            ..Settings::default()
        }
    );
    assert_eq!(loaded.fell_back, [SettingKey::Theme, SettingKey::Mode]);
}

#[test]
fn unknown_keys_are_left_alone() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    store(&path, "navigation", "\"top\"");

    let loaded = load(&open(&path)).expect("load");
    save(&mut open(&path), &CHOSEN).expect("save");

    assert_eq!(loaded, Loaded::default());
    let kept: String = Connection::open(&path)
        .expect("database")
        .query_row(
            "SELECT value FROM settings WHERE key = 'navigation'",
            [],
            |row| row.get(0),
        )
        .expect("row");
    assert_eq!(kept, "\"top\"");
}

#[test]
fn saving_replaces_unreadable_values() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    store(&path, "theme", "{");

    save(&mut open(&path), &CHOSEN).expect("save");

    let loaded = load(&open(&path)).expect("load");
    assert_eq!(loaded.settings, CHOSEN);
    assert!(loaded.fell_back.is_empty());
}

#[test]
fn a_failed_save_keeps_every_old_value() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    save(&mut open(&path), &Settings::default()).expect("first save");
    // The last of the three writes fails; the first two must be rolled back with it.
    Connection::open(&path)
        .expect("database")
        .execute_batch(
            "CREATE TRIGGER refuse_frame BEFORE UPDATE ON settings
             WHEN NEW.key = 'frame' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        )
        .expect("trigger");

    assert!(save(&mut open(&path), &CHOSEN).is_err());

    assert_eq!(
        load(&open(&path)).expect("load").settings,
        Settings::default()
    );
}

#[test]
fn a_write_protected_database_reports_read_only() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    // Opened after the file is protected; an earlier handle could still write.
    read_only(&path);
    let mut conn = Connection::open(&path).expect("database");

    assert!(matches!(save(&mut conn, &CHOSEN), Err(DbError::ReadOnly)));
    assert_eq!(load(&conn).expect("load"), Loaded::default());
}
