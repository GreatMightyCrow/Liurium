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
    startup: StartWith::ProjectList,
    zoom: Zoom(150),
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
            startup: StartWith::LastProject,
            zoom: Zoom(100),
        }
    );
}

#[test]
fn zoom_accepts_only_the_listed_steps() {
    for step in Zoom::STEPS {
        assert_eq!(Zoom::try_from(step).map(Zoom::percent), Ok(step));
    }
    for other in [0, 49, 66, 100 + 1, 130, 201, 400] {
        assert!(Zoom::try_from(other).is_err(), "{other} must be refused");
    }
    assert!(Zoom::STEPS.windows(2).all(|pair| pair[0] < pair[1]));
    assert!((Zoom::default().factor() - 1.0).abs() < f64::EPSILON);
    assert!((Zoom(125).factor() - 1.25).abs() < f64::EPSILON);
}

#[test]
fn settings_from_the_page_refuse_a_zoom_outside_the_steps() {
    let page =
        r#"{"theme":"orange","mode":"dark","frame":"native","startup":"projectList","zoom":130}"#;
    assert!(serde_json::from_str::<Settings>(page).is_err());
    let page = page.replace("130", "125");
    let settings: Settings = serde_json::from_str(&page).expect("allowed step");
    assert_eq!(settings.zoom, Zoom(125));
    assert_eq!(settings.startup, StartWith::ProjectList);
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
            ("startup".to_owned(), "\"projectList\"".to_owned()),
            ("theme".to_owned(), "\"mint-graphite\"".to_owned()),
            ("zoom".to_owned(), "150".to_owned()),
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
    store(&path, "startup", "\"dashboard\"");
    store(&path, "zoom", "130");

    let loaded = load(&open(&path)).expect("load");

    assert_eq!(
        loaded.settings,
        Settings {
            frame: FrameStyle::Hidden,
            ..Settings::default()
        }
    );
    assert_eq!(
        loaded.fell_back,
        [
            SettingKey::Theme,
            SettingKey::Mode,
            SettingKey::Startup,
            SettingKey::Zoom
        ]
    );
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
    // One of the writes fails; the ones before it must be rolled back with it.
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
