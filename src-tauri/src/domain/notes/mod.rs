//! The notes of a project (M3-002): found by walking its folder and kept in the
//! project's cache, which can be thrown away and built again at any time (ADR-0016).
//! Only the cache is written; the project folder is only read.

pub mod session;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod tests;
pub mod text;

use std::{
    collections::HashMap,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, TransactionBehavior, params};

use crate::storage::{
    db::{self, DbError},
    fs::{Limits, ProjectRoot, Skipped, Walk},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedNote {
    /// Below the project root, parts joined with `/`.
    pub path: String,
    pub size: u64,
    /// Nanoseconds since 1970-01-01 UTC; negative before.
    pub modified_ns: i64,
}

/// How the cache changed in one refresh.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Changes {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Index {
    /// Read back from the cache, sorted by path without case first.
    pub notes: Vec<IndexedNote>,
    pub changes: Changes,
    /// The cache was missing or unusable and was built from scratch.
    pub rebuilt: bool,
    pub skipped: Skipped,
    /// The walk stopped at the note limit.
    pub truncated: bool,
}

/// Walks the project and brings its cache up to date: new notes added, notes with
/// another size or modified time updated, notes no longer found removed.
pub fn refresh(app_dir: &Path, project_id: &str, root: &ProjectRoot) -> Result<Index, DbError> {
    refresh_with(app_dir, project_id, root, Limits::DEFAULT)
}

pub fn refresh_with(
    app_dir: &Path,
    project_id: &str,
    root: &ProjectRoot,
    limits: Limits,
) -> Result<Index, DbError> {
    let walk = root.find_notes(limits);
    let mut cache = db::open_cache(app_dir, project_id)?;
    let changes = update(&mut cache.connection, &walk)?;
    Ok(Index {
        notes: read(&cache.connection)?,
        changes,
        rebuilt: cache.fresh,
        skipped: walk.skipped,
        truncated: walk.truncated,
    })
}

/// One transaction: the cache is either the old or the new list, never half.
fn update(conn: &mut Connection, walk: &Walk) -> Result<Changes, DbError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut statement = tx.prepare("SELECT path, size, modified_ns FROM notes")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
        for row in rows {
            let (path, stamp) = row?;
            known.insert(path, stamp);
        }
    }
    let mut changes = Changes::default();
    for note in &walk.notes {
        let path = note.path.to_string();
        let stamp = (
            i64::try_from(note.stamp.len).unwrap_or(i64::MAX),
            nanos(note.stamp.modified),
        );
        match known.remove(&path) {
            None => {
                tx.execute(
                    "INSERT INTO notes (path, size, modified_ns) VALUES (?1, ?2, ?3)",
                    params![path, stamp.0, stamp.1],
                )?;
                changes.added += 1;
            }
            Some(old) if old != stamp => {
                tx.execute(
                    "UPDATE notes SET size = ?2, modified_ns = ?3 WHERE path = ?1",
                    params![path, stamp.0, stamp.1],
                )?;
                changes.changed += 1;
            }
            Some(_) => {}
        }
    }
    for path in known.keys() {
        tx.execute("DELETE FROM notes WHERE path = ?1", [path])?;
        changes.removed += 1;
    }
    tx.commit()?;
    Ok(changes)
}

fn read(conn: &Connection) -> Result<Vec<IndexedNote>, DbError> {
    let mut statement = conn.prepare("SELECT path, size, modified_ns FROM notes")?;
    let rows = statement.query_map([], |row| {
        let size: i64 = row.get(1)?;
        Ok(IndexedNote {
            path: row.get(0)?,
            size: u64::try_from(size).unwrap_or(0),
            modified_ns: row.get(2)?,
        })
    })?;
    let mut notes = rows.collect::<Result<Vec<_>, _>>()?;
    notes.sort_by_cached_key(|note| (note.path.to_lowercase(), note.path.clone()));
    Ok(notes)
}

fn nanos(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_nanos()).map_or(i64::MIN, |n| -n),
    }
}
