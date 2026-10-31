//! Every open and migration path against real SQLite files in temp folders. Older
//! databases come from hand-built fixtures (`test_support`), not from the runner.

use std::{ffi::OsStr, fs};

use super::*;
use crate::test_support::{Snapshot, app_data, current, damage, database, project, temp_dir};

const NOTES: &str = "CREATE TABLE notes (body TEXT NOT NULL) STRICT;";
const TAGS: &str = "CREATE TABLE tags (name TEXT NOT NULL) STRICT;";

const V1: Schema = Schema {
    application_id: PROJECT_ID,
    migrations: &[NOTES],
};
const V2: Schema = Schema {
    application_id: PROJECT_ID,
    migrations: &[NOTES, TAGS],
};
/// The second migration creates a table, then fails.
const BROKEN_V2: Schema = Schema {
    application_id: PROJECT_ID,
    migrations: &[
        NOTES,
        "CREATE TABLE tags (name TEXT) STRICT; INSERT INTO missing VALUES (1);",
    ],
};
/// The second migration needs more pages than the database may grow to.
const LARGE_V2: Schema = Schema {
    application_id: PROJECT_ID,
    migrations: &[
        NOTES,
        "CREATE TABLE large (data BLOB NOT NULL) STRICT; INSERT INTO large VALUES (zeroblob(1000000));",
    ],
};

fn open_schema(path: &Path, schema: &Schema) -> Result<Connection, DbError> {
    open_with(
        path,
        Kind::Project,
        OpenMode::CreateIfMissing,
        schema,
        BUSY_TIMEOUT,
    )
}

/// The older-schema fixture: a hand-built V1 database with one note in it.
fn v1_with_a_note(path: &Path) {
    database(path, &V1)
        .execute("INSERT INTO notes VALUES ('kept')", [])
        .expect("insert");
}

fn number(conn: &Connection, pragma: &str) -> i64 {
    conn.pragma_query_value(None, pragma, |row| row.get(0))
        .expect(pragma)
}

fn text(conn: &Connection, pragma: &str) -> String {
    conn.pragma_query_value(None, pragma, |row| row.get(0))
        .expect(pragma)
}

fn column(conn: &Connection, sql: &str) -> Vec<String> {
    let mut statement = conn.prepare(sql).expect("query");
    statement
        .query_map([], |row| row.get(0))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("values")
}

fn tables(conn: &Connection) -> Vec<String> {
    column(
        conn,
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
}

fn notes(conn: &Connection) -> Vec<String> {
    column(conn, "SELECT body FROM notes")
}

fn backups(path: &Path) -> Vec<PathBuf> {
    let dir = path.parent().expect("folder").join(BACKUP_DIR);
    match fs::read_dir(dir) {
        Ok(entries) => entries.map(|entry| entry.expect("entry").path()).collect(),
        Err(_) => Vec::new(),
    }
}

fn file_name(path: &Path) -> &str {
    path.file_name().and_then(OsStr::to_str).expect("file name")
}

#[test]
fn a_new_app_database_is_created_and_migrated() {
    let dir = temp_dir();
    let app_dir = dir.path().join("io.github.greatmightycrow.liurium");
    let app = open_app(&app_dir).expect("app database");
    let conn = &app.connection;

    assert_eq!(app.moved_aside, None);
    assert_eq!(number(conn, "user_version"), 1);
    assert_eq!(number(conn, "application_id"), i64::from(APP_ID));
    assert_eq!(text(conn, "journal_mode"), "wal");
    assert_eq!(number(conn, "foreign_keys"), 1);
    assert_eq!(tables(conn), ["projects", "settings"]);
    assert!(backups(&app_dir.join(APP_DB)).is_empty());
}

#[test]
fn an_existing_registry_survives_reopening() {
    let dir = temp_dir();
    let notes = project(dir.path(), "Notes", current(Kind::Project));
    let app_dir = dir.path().join("app");
    app_data(&app_dir, &[&notes]);

    let app = open_app(&app_dir).expect("app database");

    assert_eq!(app.moved_aside, None);
    assert_eq!(
        column(&app.connection, "SELECT id FROM projects"),
        std::slice::from_ref(&notes.id)
    );
    assert!(backups(&app_dir.join(APP_DB)).is_empty());
}

#[test]
fn a_new_project_database_uses_the_rollback_journal() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    let conn = open(&path, Kind::Project, OpenMode::CreateIfMissing).expect("project database");

    assert_eq!(text(&conn, "journal_mode"), "delete");
    // FULL
    assert_eq!(number(&conn, "synchronous"), 2);
    assert_eq!(number(&conn, "user_version"), 1);
    assert_eq!(number(&conn, "application_id"), i64::from(PROJECT_ID));
    assert_eq!(tables(&conn), ["meta"]);

    // Between transactions the .db file alone holds everything.
    drop(conn);
    let files: Vec<_> = fs::read_dir(dir.path())
        .expect("folder")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(files, ["project.db"]);
}

#[test]
fn a_missing_database_is_reported_and_not_created() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    let error = open(&path, Kind::Project, OpenMode::Existing).unwrap_err();

    assert!(matches!(error, DbError::Missing), "{error:?}");
    assert!(!path.exists());
}

#[test]
fn reopening_a_current_database_writes_nothing() {
    let dir = temp_dir();
    let fixture = project(dir.path(), "Notes", current(Kind::Project));
    let path = fixture.database();
    let before = Snapshot::of(&path);

    drop(open(&path, Kind::Project, OpenMode::Existing).expect("reopened"));

    before.assert_unchanged(&path);
    assert!(backups(&path).is_empty());
}

#[test]
fn an_older_schema_is_upgraded_after_a_backup() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    v1_with_a_note(&path);

    let conn = open_schema(&path, &V2).expect("upgraded");
    assert_eq!(number(&conn, "user_version"), 2);
    assert_eq!(tables(&conn), ["notes", "tags"]);
    assert_eq!(notes(&conn), ["kept"]);

    let copies = backups(&path);
    assert_eq!(copies.len(), 1);
    let name = file_name(&copies[0]);
    assert!(
        name.starts_with("project-v1-") && name.ends_with(".db"),
        "{name}"
    );

    // The copy is the complete V1 database, header included.
    let copy =
        Connection::open_with_flags(&copies[0], OpenFlags::SQLITE_OPEN_READ_ONLY).expect("backup");
    assert_eq!(text(&copy, "integrity_check"), "ok");
    assert_eq!(number(&copy, "user_version"), 1);
    assert_eq!(number(&copy, "application_id"), i64::from(PROJECT_ID));
    assert_eq!(notes(&copy), ["kept"]);
}

#[test]
fn a_failed_migration_rolls_back_and_keeps_a_restorable_backup() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    v1_with_a_note(&path);
    let before = Snapshot::of(&path);

    let error = open_schema(&path, &BROKEN_V2).unwrap_err();
    assert!(
        matches!(error, DbError::Migration { version: 2, .. }),
        "{error:?}"
    );
    before.assert_unchanged(&path);

    let conn = open_schema(&path, &V1).expect("still V1");
    assert_eq!(number(&conn, "user_version"), 1);
    assert_eq!(tables(&conn), ["notes"]);
    drop(conn);

    // Restoring the backup gives back the database from before the attempt.
    let copies = backups(&path);
    assert_eq!(copies.len(), 1);
    fs::remove_file(&path).expect("remove");
    fs::copy(&copies[0], &path).expect("restore");
    let restored =
        open_with(&path, Kind::Project, OpenMode::Existing, &V1, BUSY_TIMEOUT).expect("restored");
    assert_eq!(notes(&restored), ["kept"]);
}

#[test]
fn a_full_disk_during_a_migration_rolls_back() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    v1_with_a_note(&path);

    let mut conn = Connection::open(&path).expect("database");
    let pages = number(&conn, "page_count");
    conn.pragma_update(None, "max_page_count", pages)
        .expect("size limit");
    let error = migrate::migrate(&mut conn, &LARGE_V2, &path, 1).unwrap_err();
    assert!(matches!(error, DbError::DiskFull), "{error:?}");
    drop(conn);

    // The backup ran before the limit was hit.
    assert_eq!(backups(&path).len(), 1);
    let conn = open_schema(&path, &V1).expect("still V1");
    assert_eq!(tables(&conn), ["notes"]);
    assert_eq!(notes(&conn), ["kept"]);
}

#[test]
fn a_newer_schema_is_refused_and_left_untouched() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    drop(database(&path, &V2));
    let before = Snapshot::of(&path);

    let error = open_schema(&path, &V1).unwrap_err();

    assert!(
        matches!(
            error,
            DbError::NewerSchema {
                found: 2,
                supported: 1
            }
        ),
        "{error:?}"
    );
    before.assert_unchanged(&path);
    assert!(backups(&path).is_empty());
}

#[test]
fn a_file_that_is_not_a_database_is_corrupt_and_left_untouched() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    fs::write(&path, b"plain text, not SQLite").expect("write");
    let before = Snapshot::of(&path);

    let error = open(&path, Kind::Project, OpenMode::Existing).unwrap_err();

    assert!(matches!(error, DbError::Corrupt), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_damaged_database_is_corrupt_and_left_untouched() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    v1_with_a_note(&path);
    damage(&path);
    let before = Snapshot::of(&path);

    let error = open_schema(&path, &V1).unwrap_err();

    assert!(matches!(error, DbError::Corrupt), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_foreign_sqlite_file_is_refused_and_left_untouched() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    let other = Connection::open(&path).expect("database");
    other
        .execute_batch("CREATE TABLE other (x);")
        .expect("table");
    drop(other);
    let before = Snapshot::of(&path);

    let error = open(&path, Kind::Project, OpenMode::Existing).unwrap_err();

    assert!(matches!(error, DbError::NotLiurium), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_project_database_is_not_opened_as_the_app_database() {
    let dir = temp_dir();
    let fixture = project(dir.path(), "Notes", current(Kind::Project));
    let path = fixture.database();
    let before = Snapshot::of(&path);

    let error = open(&path, Kind::App, OpenMode::Existing).unwrap_err();

    assert!(matches!(error, DbError::NotLiurium), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_locked_database_reports_locked_and_is_left_untouched() {
    let dir = temp_dir();
    let fixture = project(dir.path(), "Notes", current(Kind::Project));
    let path = fixture.database();
    let before = Snapshot::of(&path);

    // In rollback mode an exclusive transaction keeps every reader out.
    let holder = Connection::open(&path).expect("database");
    holder.execute_batch("BEGIN EXCLUSIVE;").expect("lock");
    let error = open_with(
        &path,
        Kind::Project,
        OpenMode::Existing,
        &PROJECT_SCHEMA,
        Duration::from_millis(50),
    )
    .unwrap_err();
    holder.execute_batch("ROLLBACK;").expect("unlock");
    drop(holder);

    assert!(matches!(error, DbError::Locked), "{error:?}");
    before.assert_unchanged(&path);
}

#[test]
fn a_damaged_app_database_is_moved_aside_and_replaced() {
    let dir = temp_dir();
    let path = dir.path().join(APP_DB);
    fs::write(&path, b"plain text, not SQLite").expect("write");

    let app = open_app(dir.path()).expect("app database");

    let moved = app.moved_aside.as_deref().expect("moved file");
    assert_eq!(moved.parent(), Some(dir.path().join(BACKUP_DIR).as_path()));
    assert!(file_name(moved).starts_with("app-broken-"), "{moved:?}");
    assert_eq!(fs::read(moved).expect("moved"), b"plain text, not SQLite");
    assert_eq!(number(&app.connection, "user_version"), 1);
    assert_eq!(tables(&app.connection), ["projects", "settings"]);
}

// Tested without opening: closing the last connection checkpoints and deletes a
// `-wal` file, and one without a valid header holds nothing to keep.
#[test]
fn moving_aside_takes_the_side_files_along() {
    let dir = temp_dir();
    let path = dir.path().join(APP_DB);
    fs::write(&path, b"database").expect("write");
    fs::write(with_suffix(&path, "-wal"), b"wal").expect("write");
    fs::write(with_suffix(&path, "-shm"), b"shm").expect("write");

    let moved = move_aside(&path).expect("moved");

    assert!(!path.exists());
    assert_eq!(fs::read(&moved).expect("moved"), b"database");
    assert_eq!(fs::read(with_suffix(&moved, "-wal")).expect("wal"), b"wal");
    assert_eq!(fs::read(with_suffix(&moved, "-shm")).expect("shm"), b"shm");
    assert!(!with_suffix(&moved, "-journal").exists());
}

#[test]
fn a_newer_app_database_stays_where_it_is() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    Connection::open(&path)
        .expect("database")
        .pragma_update(None, "user_version", 7)
        .expect("version");
    let before = Snapshot::of(&path);

    let error = open_app(dir.path()).unwrap_err();

    assert!(
        matches!(
            error,
            DbError::NewerSchema {
                found: 7,
                supported: 1
            }
        ),
        "{error:?}"
    );
    before.assert_unchanged(&path);
    assert!(backups(&path).is_empty());
}

#[test]
fn backup_names_never_reuse_a_file() {
    let dir = temp_dir();
    let path = dir.path().join("project.db");
    let first = migrate::backup_path(&path, "v1").expect("name");
    fs::write(&first, b"first").expect("write");

    let second = migrate::backup_path(&path, "v1").expect("name");

    assert_ne!(first, second);
    assert!(!second.exists());
}

#[test]
fn each_kind_has_its_own_application_id() {
    assert_ne!(APP_ID, 0);
    assert_ne!(PROJECT_ID, 0);
    assert_ne!(APP_ID, PROJECT_ID);
}
