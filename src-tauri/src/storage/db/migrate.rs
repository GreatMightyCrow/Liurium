//! Versioned migrations. The schema version is SQLite's `user_version`; migration `n`
//! is entry `n` (counting from 1) of a schema's list. Lists only grow: a released
//! migration is never edited, a change is a new entry.

use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, TransactionBehavior};

use super::DbError;

/// Folder next to a database that holds its copies from before migrations.
pub const BACKUP_DIR: &str = "backups";

pub struct Schema {
    /// Stored in the file header (`PRAGMA application_id`) so Liurium recognizes its
    /// own files and never migrates a foreign database or one of the other kind.
    pub application_id: i32,
    pub migrations: &'static [&'static str],
}

impl Schema {
    pub fn version(&self) -> u32 {
        u32::try_from(self.migrations.len()).expect("fewer than 2^32 migrations")
    }
}

pub fn user_version(conn: &Connection) -> Result<u32, DbError> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    u32::try_from(version).map_err(|_| DbError::NotLiurium)
}

/// Brings the database from version `found` to the schema's version. An existing
/// database is copied to `backups/` first. All pending migrations run in one
/// transaction, so the file ends either fully upgraded or unchanged.
pub fn migrate(
    conn: &mut Connection,
    schema: &Schema,
    path: &Path,
    found: u32,
) -> Result<(), DbError> {
    let supported = schema.version();
    if found == supported {
        return Ok(());
    }
    if found > 0 {
        backup(conn, path, found)?;
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Read again under the write lock: another process may have migrated meanwhile.
    let current = user_version(&tx)?;
    if current > supported {
        return Err(DbError::NewerSchema {
            found: current,
            supported,
        });
    }
    for (version, sql) in (1..).zip(schema.migrations) {
        if version > current {
            tx.execute_batch(sql)
                .map_err(|error| failed(version, error))?;
        }
    }
    tx.pragma_update(None, "application_id", schema.application_id)?;
    tx.pragma_update(None, "user_version", supported)?;
    tx.commit()?;
    Ok(())
}

/// Locks, a full disk, and damage keep their own error; anything else is the
/// migration's fault.
fn failed(version: u32, error: rusqlite::Error) -> DbError {
    match DbError::from(error) {
        DbError::Sqlite(source) => DbError::Migration { version, source },
        other => other,
    }
}

/// `VACUUM INTO` writes a consistent snapshot, also of a live database
/// (sqlite.org/lang_vacuum.html §2.1).
fn backup(conn: &Connection, path: &Path, version: u32) -> Result<PathBuf, DbError> {
    let target = backup_path(path, &format!("v{version}"))?;
    let name = target.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidFilename, "backup path is not Unicode")
    })?;
    conn.execute("VACUUM INTO ?1", [name])?;
    Ok(target)
}

/// A new file name in the `backups` folder next to `path`, such as
/// `project-v1-20261030T101500Z.db`. Never an existing file.
pub fn backup_path(path: &Path, label: &str) -> Result<PathBuf, DbError> {
    let dir = path.parent().unwrap_or(Path::new("")).join(BACKUP_DIR);
    fs::create_dir_all(&dir)?;
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("database");
    let base = format!("{stem}-{label}-{}", utc_stamp()?);
    let mut target = dir.join(format!("{base}.db"));
    let mut count = 1;
    while target.try_exists()? {
        count += 1;
        target = dir.join(format!("{base}-{count}.db"));
    }
    Ok(target)
}

/// SQLite already formats UTC dates; no date crate needed.
fn utc_stamp() -> Result<String, DbError> {
    let conn = Connection::open_in_memory()?;
    Ok(
        conn.query_row("SELECT strftime('%Y%m%dT%H%M%SZ', 'now')", [], |row| {
            row.get(0)
        })?,
    )
}
