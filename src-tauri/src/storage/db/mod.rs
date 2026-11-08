//! SQLite databases (ADR-0016, ADR-0017): `app.db` in the app folder, `project.db`
//! in each project's `.liurium` folder, and one cache per project in `cache`.
//! Opening checks a file before anything writes to it: integrity, owner, and schema
//! version come first, then journal mode and migrations. Project databases are
//! untrusted input (Security Model).

pub mod backups;
mod error;
mod migrate;
#[cfg(test)]
mod tests;

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, config::DbConfig};

pub use error::DbError;
pub use migrate::BACKUP_DIR;
pub(crate) use migrate::Schema;

pub const APP_DB: &str = "app.db";
/// Inside a project's `.liurium` folder.
pub const PROJECT_DB: &str = "project.db";
/// Folder in the app data folder for the caches, one `<project id>.db` each.
pub const CACHE_DIR: &str = "cache";

/// How long to wait for another connection's lock before reporting `Locked`.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// "LiuA", "LiuP", and "LiuC".
const APP_ID: i32 = 0x4C69_7541;
const PROJECT_ID: i32 = 0x4C69_7550;
const CACHE_ID: i32 = 0x4C69_7543;

static APP_SCHEMA: Schema = Schema {
    application_id: APP_ID,
    migrations: &[
        include_str!("migrations/app/0001_projects_and_settings.sql"),
        include_str!("migrations/app/0002_sync_warning.sql"),
    ],
};

static PROJECT_SCHEMA: Schema = Schema {
    application_id: PROJECT_ID,
    migrations: &[
        include_str!("migrations/project/0001_meta.sql"),
        include_str!("migrations/project/0002_property_kinds.sql"),
    ],
};

static CACHE_SCHEMA: Schema = Schema {
    application_id: CACHE_ID,
    migrations: &[
        include_str!("migrations/cache/0001_notes.sql"),
        include_str!("migrations/cache/0002_links.sql"),
        include_str!("migrations/cache/0003_tags_and_aliases.sql"),
        include_str!("migrations/cache/0004_search.sql"),
    ],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Registry and settings, on the local disk, used by one process.
    App,
    /// Identity and tasks, inside a project folder that sync tools and Git copy.
    Project,
    /// What Liurium found in a project's files (M3-002), on the local disk. Rebuildable,
    /// so it is never backed up: a cache that cannot be opened is deleted and built
    /// again.
    Cache,
}

impl Kind {
    pub(crate) fn schema(self) -> &'static Schema {
        match self {
            Self::App => &APP_SCHEMA,
            Self::Project => &PROJECT_SCHEMA,
            Self::Cache => &CACHE_SCHEMA,
        }
    }

    /// The rollback journal keeps a project's `.db` file complete between
    /// transactions, so a sync tool or Git can copy it alone.
    fn journal_mode(self) -> &'static str {
        match self {
            Self::App | Self::Cache => "wal",
            Self::Project => "delete",
        }
    }

    /// With WAL, NORMAL may lose the last commit on power loss but never corrupts;
    /// `app.db` holds only preferences. The rollback journal needs FULL.
    fn synchronous(self) -> &'static str {
        match self {
            Self::App | Self::Cache => "NORMAL",
            Self::Project => "FULL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// Creates an empty database when the file is missing.
    CreateIfMissing,
    /// Reports `Missing` instead of creating a file.
    Existing,
}

/// Opens a database and migrates it to the version this build knows.
pub fn open(path: &Path, kind: Kind, mode: OpenMode) -> Result<Connection, DbError> {
    open_with(path, kind, mode, kind.schema(), BUSY_TIMEOUT)
}

fn open_with(
    path: &Path,
    kind: Kind,
    mode: OpenMode,
    schema: &Schema,
    busy_timeout: Duration,
) -> Result<Connection, DbError> {
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if !path.try_exists()? {
        if mode == OpenMode::Existing {
            return Err(DbError::Missing);
        }
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let mut conn = Connection::open_with_flags(path, flags)?;
    configure(&conn, busy_timeout)?;
    check_integrity(&conn)?;
    let found = check_owner(&conn, schema)?;
    set_journal_mode(&conn, kind)?;
    conn.pragma_update(None, "synchronous", kind.synchronous())?;
    // A write-protected project cannot be upgraded and must not be written; it stays
    // readable at its version (M3-015). Whatever is newer than that version must cope
    // with its absence.
    let frozen = kind == Kind::Project && found > 0 && conn.is_readonly(rusqlite::MAIN_DB)?;
    if !frozen {
        migrate::migrate(&mut conn, schema, path, found, kind != Kind::Cache)?;
    }
    Ok(conn)
}

/// The defenses sqlite.org/security.html (§1.1, §1.2) lists for database files from
/// outside. None of these reads the file.
fn configure(conn: &Connection, busy_timeout: Duration) -> Result<(), DbError> {
    conn.busy_timeout(busy_timeout)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    conn.pragma_update(None, "cell_size_check", true)?;
    conn.pragma_update(None, "mmap_size", 0)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

fn check_integrity(conn: &Connection) -> Result<(), DbError> {
    let result: String = conn.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(DbError::Corrupt)
    }
}

/// Only an empty new file or a file with this kind's application id passes, and its
/// version must be one this build knows. Returns that version.
fn check_owner(conn: &Connection, schema: &Schema) -> Result<u32, DbError> {
    let application_id: i32 = conn.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version = migrate::user_version(conn)?;
    let objects: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
    let empty = application_id == 0 && version == 0 && objects == 0;
    if !empty && application_id != schema.application_id {
        return Err(DbError::NotLiurium);
    }
    let supported = schema.version();
    if version > supported {
        return Err(DbError::NewerSchema {
            found: version,
            supported,
        });
    }
    Ok(version)
}

fn set_journal_mode(conn: &Connection, kind: Kind) -> Result<(), DbError> {
    let wanted = kind.journal_mode();
    let got: String =
        conn.pragma_update_and_check(None, "journal_mode", wanted, |row| row.get(0))?;
    if got.eq_ignore_ascii_case(wanted) {
        Ok(())
    } else {
        Err(DbError::JournalMode { wanted, got })
    }
}

#[derive(Debug)]
pub struct AppDb {
    pub connection: Connection,
    /// Where a damaged or foreign `app.db` was moved, for a notice to the user.
    pub moved_aside: Option<PathBuf>,
}

/// Opens `app.db` in the app folder and creates both when missing. A damaged or
/// foreign `app.db` holds only preferences (ADR-0016): it moves to `backups` with
/// its side files and a new one is created. A newer or locked database stays.
pub fn open_app(dir: &Path) -> Result<AppDb, DbError> {
    fs::create_dir_all(dir)?;
    let path = dir.join(APP_DB);
    match open(&path, Kind::App, OpenMode::CreateIfMissing) {
        Ok(connection) => Ok(AppDb {
            connection,
            moved_aside: None,
        }),
        Err(DbError::Corrupt | DbError::NotLiurium) => {
            let moved = move_aside(&path)?;
            let connection = open(&path, Kind::App, OpenMode::CreateIfMissing)?;
            Ok(AppDb {
                connection,
                moved_aside: Some(moved),
            })
        }
        Err(error) => Err(error),
    }
}

/// SQLite's side files, which belong to the database file of the same name.
const SIDE_FILES: [&str; 3] = ["-wal", "-shm", "-journal"];

#[derive(Debug)]
pub struct CacheDb {
    pub connection: Connection,
    /// The file was missing or could not be used and starts empty.
    pub fresh: bool,
}

/// Opens the cache of one project, `<app dir>\cache\<project id>.db`, and creates
/// folder and file when missing. A cache that is damaged, foreign, from a newer
/// version, or fails to migrate holds only what the project's files give back
/// (ADR-0016), so it is deleted with its side files and created again. Nothing
/// outside the cache folder is touched, and no link is followed.
pub fn open_cache(app_dir: &Path, project_id: &str) -> Result<CacheDb, DbError> {
    let is_id = !project_id.is_empty()
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    if !is_id {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a project id").into());
    }
    let dir = app_dir.join(CACHE_DIR);
    // Two walks may start at once (two projects opened quickly): whoever creates the
    // folder second finds it there, which is fine as long as it is a real folder.
    match fs::create_dir(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&dir)?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(io::Error::new(io::ErrorKind::NotADirectory, "cache is not a folder").into());
    }
    let path = dir.join(format!("{project_id}.db"));
    // A link where the cache belongs is removed, never followed.
    let linked = fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_symlink());
    let missing = linked || !path.try_exists()?;
    if linked {
        remove_cache(&path)?;
    }
    match open(&path, Kind::Cache, OpenMode::CreateIfMissing) {
        Ok(connection) => Ok(CacheDb {
            connection,
            fresh: missing,
        }),
        Err(
            DbError::Corrupt
            | DbError::NotLiurium
            | DbError::NewerSchema { .. }
            | DbError::Migration { .. },
        ) => {
            remove_cache(&path)?;
            Ok(CacheDb {
                connection: open(&path, Kind::Cache, OpenMode::CreateIfMissing)?,
                fresh: true,
            })
        }
        Err(error) => Err(error),
    }
}

/// Removes a cache file and its side files: plain files or links, never a folder.
fn remove_cache(path: &Path) -> Result<(), DbError> {
    let files = std::iter::once(path.to_path_buf())
        .chain(SIDE_FILES.iter().map(|suffix| with_suffix(path, suffix)));
    for file in files {
        match fs::symlink_metadata(&file) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(
                    io::Error::new(io::ErrorKind::IsADirectory, "cache is a folder").into(),
                );
            }
            Ok(_) => fs::remove_file(&file)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// SQLite's side files move with the database, so the moved copy stays readable.
/// The failed open may already have removed a `-wal` file: SQLite checkpoints and
/// deletes it when the last connection closes (sqlite3.c, `sqlite3WalClose`).
fn move_aside(path: &Path) -> Result<PathBuf, DbError> {
    let target = migrate::backup_path(path, "broken")?;
    fs::rename(path, &target)?;
    for suffix in SIDE_FILES {
        let side = with_suffix(path, suffix);
        if side.try_exists()? {
            fs::rename(&side, with_suffix(&target, suffix))?;
        }
    }
    Ok(target)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
