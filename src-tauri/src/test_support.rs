//! Fixtures for storage and command tests (M2-008): real files in temp folders, never
//! the user's app data folder. Databases are built with plain rusqlite and `std::fs`,
//! not with the code under test, so a bug there cannot hide in its own fixtures.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

use rusqlite::{Connection, params};
use tempfile::TempDir;

use crate::storage::db::{APP_DB, Kind, Schema};

/// Removed with everything in it when dropped, including read-only files; links
/// inside are removed without touching their targets (tested below).
pub fn temp_dir() -> TempDir {
    TempDir::new().expect("temp folder")
}

/// A database built by hand: the schema's migrations applied in order, its
/// application id and `user_version` written, rollback journal. The connection is
/// returned for extra rows; drop it before opening the file with the code under test.
pub fn database(path: &Path, schema: &Schema) -> Connection {
    let conn = Connection::open(path).expect("database file");
    for sql in schema.migrations {
        conn.execute_batch(sql).expect("migration");
    }
    conn.pragma_update(None, "application_id", schema.application_id)
        .expect("application id");
    conn.pragma_update(None, "user_version", schema.version())
        .expect("version");
    conn
}

/// A Liurium database of `kind` at `version`, using the real migrations up to it.
pub fn liurium_database(path: &Path, kind: Kind, version: usize) -> Connection {
    let real = kind.schema();
    let schema = Schema {
        application_id: real.application_id,
        migrations: &real.migrations[..version],
    };
    database(path, &schema)
}

/// The current version of `kind`.
pub fn current(kind: Kind) -> usize {
    kind.schema().migrations.len()
}

pub struct ProjectFixture {
    pub root: PathBuf,
    pub id: String,
    pub name: String,
}

impl ProjectFixture {
    pub fn database(&self) -> PathBuf {
        self.root.join(".liurium").join("project.db")
    }
}

/// A project folder with `.liurium/project.db` at `version`. From version 1 on, its
/// `meta` table holds `id` (UUID v4 form) and `name`, as planned in ADR-0016.
pub fn project(parent: &Path, name: &str, version: usize) -> ProjectFixture {
    static COUNT: AtomicU64 = AtomicU64::new(1);
    let fixture = ProjectFixture {
        root: parent.join(name),
        id: format!(
            "00000000-0000-4000-8000-{:012x}",
            COUNT.fetch_add(1, Ordering::Relaxed)
        ),
        name: name.to_owned(),
    };
    fs::create_dir_all(fixture.root.join(".liurium")).expect("project folder");
    let conn = liurium_database(&fixture.database(), Kind::Project, version);
    if version >= 1 {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('id', ?1), ('name', ?2)",
            params![fixture.id, fixture.name],
        )
        .expect("identity");
    }
    fixture
}

/// `app.db` at the current version in `dir`, with these projects in the registry.
pub fn app_data(dir: &Path, projects: &[&ProjectFixture]) -> PathBuf {
    fs::create_dir_all(dir).expect("app folder");
    let path = dir.join(APP_DB);
    let conn = liurium_database(&path, Kind::App, current(Kind::App));
    for project in projects {
        conn.execute(
            "INSERT INTO projects (id, path, name) VALUES (?1, ?2, ?3)",
            params![project.id, project.root.to_string_lossy(), project.name],
        )
        .expect("registry entry");
    }
    path
}

/// Breaks the b-tree on page 2 (the first table) with an invalid page header.
pub fn damage(path: &Path) {
    let mut bytes = fs::read(path).expect("database file");
    let page_size = usize::from(u16::from_be_bytes([bytes[16], bytes[17]]));
    assert!(bytes.len() >= 2 * page_size, "needs at least two pages");
    bytes[page_size..page_size + 8].fill(0xff);
    fs::write(path, bytes).expect("write");
}

pub fn read_only(path: &Path) {
    let mut permissions = fs::metadata(path).expect("file").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).expect("read-only");
}

/// Junctions need no special rights, unlike symbolic links.
pub fn junction(link: &Path, target: &Path) {
    let output = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .expect("mklink");
    assert!(output.status.success(), "{output:?}");
}

/// Bytes and modified time of a file, to prove that nothing wrote to it.
#[derive(Debug, PartialEq, Eq)]
pub struct Snapshot {
    bytes: Vec<u8>,
    modified: SystemTime,
}

impl Snapshot {
    pub fn of(path: &Path) -> Self {
        Self {
            bytes: fs::read(path).expect("file"),
            modified: fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .expect("modified time"),
        }
    }

    #[track_caller]
    pub fn assert_unchanged(&self, path: &Path) {
        let now = Self::of(path);
        assert!(now.bytes == self.bytes, "{} changed", path.display());
        assert_eq!(
            now.modified,
            self.modified,
            "{} was written",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::storage::db::{self, DbError, OpenMode};

    fn schema_of(conn: &Connection) -> Vec<(String, String, Option<String>)> {
        let mut statement = conn
            .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
            .expect("query");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("schema")
    }

    fn header(conn: &Connection) -> (i64, i64) {
        let read = |name| {
            conn.pragma_query_value(None, name, |row| row.get(0))
                .expect(name)
        };
        (read("application_id"), read("user_version"))
    }

    #[test]
    fn hand_built_databases_match_migrated_ones() {
        let dir = temp_dir();
        for kind in [Kind::App, Kind::Project] {
            let built = dir.path().join(format!("{kind:?}-built.db"));
            let migrated = dir.path().join(format!("{kind:?}-migrated.db"));
            let built = liurium_database(&built, kind, current(kind));
            let migrated = db::open(&migrated, kind, OpenMode::CreateIfMissing).expect("open");

            assert_eq!(schema_of(&built), schema_of(&migrated), "{kind:?}");
            assert_eq!(header(&built), header(&migrated), "{kind:?}");
        }
    }

    #[test]
    fn a_project_fixture_opens_without_being_written() {
        let dir = temp_dir();
        let fixture = project(dir.path(), "Notes", current(Kind::Project));
        let before = Snapshot::of(&fixture.database());

        let conn = db::open(&fixture.database(), Kind::Project, OpenMode::Existing)
            .expect("valid project database");
        let id: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'id'", [], |row| {
                row.get(0)
            })
            .expect("id");
        drop(conn);

        assert_eq!(id, fixture.id);
        before.assert_unchanged(&fixture.database());
    }

    #[test]
    fn the_registry_fixture_lists_its_projects() {
        let dir = temp_dir();
        let first = project(dir.path(), "First", current(Kind::Project));
        let second = project(dir.path(), "Second", current(Kind::Project));
        assert_ne!(first.id, second.id);

        let app_dir = dir.path().join("app");
        app_data(&app_dir, &[&first, &second]);

        let app = db::open_app(&app_dir).expect("app database");
        let names: Vec<String> = app
            .connection
            .prepare("SELECT name FROM projects ORDER BY name")
            .expect("query")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("names");

        assert_eq!(names, ["First", "Second"]);
        assert_eq!(app.moved_aside, None);
    }

    #[test]
    fn a_damaged_fixture_is_refused_as_corrupt() {
        let dir = temp_dir();
        let fixture = project(dir.path(), "Broken", current(Kind::Project));
        damage(&fixture.database());

        let error = db::open(&fixture.database(), Kind::Project, OpenMode::Existing).unwrap_err();

        assert!(matches!(error, DbError::Corrupt), "{error:?}");
    }

    #[test]
    fn a_snapshot_notices_new_bytes_and_a_new_time() {
        let dir = temp_dir();
        let path = dir.path().join("file.txt");
        fs::write(&path, b"one").expect("write");
        let before = Snapshot::of(&path);
        before.assert_unchanged(&path);

        let file = fs::File::options().write(true).open(&path).expect("file");
        file.set_modified(SystemTime::now() + Duration::from_secs(60))
            .expect("time");
        drop(file);
        assert_ne!(Snapshot::of(&path), before);

        fs::write(&path, b"two").expect("write");
        assert_ne!(Snapshot::of(&path).bytes, before.bytes);
    }

    #[test]
    fn cleaning_up_removes_read_only_files_and_never_follows_junctions() {
        let outside = temp_dir();
        fs::write(outside.path().join("keep.txt"), b"keep").expect("write");

        let dir = temp_dir();
        let gone = dir.path().to_path_buf();
        fs::write(dir.path().join("locked.txt"), b"x").expect("write");
        read_only(&dir.path().join("locked.txt"));
        junction(&dir.path().join("link"), outside.path());
        drop(dir);

        assert!(!gone.exists(), "temp folder left behind");
        assert_eq!(
            fs::read(outside.path().join("keep.txt")).expect("target kept"),
            b"keep"
        );
    }
}
