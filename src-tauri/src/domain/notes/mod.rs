//! The notes of a project (M3-002): found by walking its folder and kept in the
//! project's cache, which can be thrown away and built again at any time (ADR-0016).
//! Only the cache is written; the project folder is only read.

pub mod backlinks;
pub mod links;
pub mod meta;
pub mod organize;
pub mod properties;
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
    fs::{Limits, ProjectRoot, RelPath, Skipped, Walk},
};

use links::{Anchor, Link, LinkKind};
use session::MAX_NOTE_BYTES;

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
    /// Notes read again to find their links: the added and changed ones (M3-005).
    pub parsed: usize,
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
    /// Folders with nothing in them, parts joined with `/` (M3-004).
    pub empty_folders: Vec<String>,
    /// (note, alias) from the notes' front matter (M3-007).
    pub aliases: Vec<(String, String)>,
}

/// What Liurium keeps from one note's text (M3-005, M3-007).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteFacts {
    pub links: Vec<Link>,
    pub tags: Vec<links::InlineTag>,
    pub front: meta::FrontMatter,
}

impl NoteFacts {
    pub fn of(text: &str) -> Self {
        let scan = links::scan(text);
        Self {
            links: scan.links,
            tags: scan.tags,
            front: meta::read(text),
        }
    }
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
    let changes = update(&mut cache.connection, &walk, root)?;
    Ok(Index {
        notes: read(&cache.connection)?,
        changes,
        rebuilt: cache.fresh,
        skipped: walk.skipped,
        truncated: walk.truncated,
        empty_folders: walk.empty_folders.iter().map(ToString::to_string).collect(),
        aliases: read_aliases(&cache.connection)?,
    })
}

fn read_aliases(conn: &Connection) -> Result<Vec<(String, String)>, DbError> {
    let mut statement = conn.prepare("SELECT source, alias FROM aliases")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The facts of one note, or none when it cannot be read as a note (too large,
/// not UTF-8, gone meanwhile): it still counts as a note, it just links nowhere.
pub(super) fn facts_of(root: &ProjectRoot, path: &RelPath) -> NoteFacts {
    root.read(path, MAX_NOTE_BYTES)
        .ok()
        .and_then(|(bytes, _)| text::decode(&bytes).ok())
        .map_or_else(NoteFacts::default, |note| NoteFacts::of(&note.text))
}

/// Notes that are new or changed are read and parsed first; then one transaction
/// writes everything, so the cache is either the old or the new state, never half.
fn update(conn: &mut Connection, walk: &Walk, root: &ProjectRoot) -> Result<Changes, DbError> {
    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut statement = conn.prepare("SELECT path, size, modified_ns FROM notes")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
        for row in rows {
            let (path, stamp) = row?;
            known.insert(path, stamp);
        }
    }
    let mut changes = Changes::default();
    let mut writes = Vec::new();
    for note in &walk.notes {
        let path = note.path.to_string();
        let stamp = (
            i64::try_from(note.stamp.len).unwrap_or(i64::MAX),
            nanos(note.stamp.modified),
        );
        let new = match known.remove(&path) {
            None => true,
            Some(old) if old != stamp => false,
            Some(_) => continue,
        };
        writes.push((path, stamp, new, facts_of(root, &note.path)));
        changes.parsed += 1;
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (path, stamp, new, found) in &writes {
        if *new {
            tx.execute(
                "INSERT INTO notes (path, size, modified_ns) VALUES (?1, ?2, ?3)",
                params![path, stamp.0, stamp.1],
            )?;
            changes.added += 1;
        } else {
            tx.execute(
                "UPDATE notes SET size = ?2, modified_ns = ?3 WHERE path = ?1",
                params![path, stamp.0, stamp.1],
            )?;
            forget_facts(&tx, path)?;
            changes.changed += 1;
        }
        write_facts(&tx, path, found)?;
    }
    // Their links go with them (ON DELETE CASCADE).
    for path in known.keys() {
        tx.execute("DELETE FROM notes WHERE path = ?1", [path])?;
        changes.removed += 1;
    }
    tx.commit()?;
    Ok(changes)
}

/// Drops a note's stored links, tags, and aliases.
fn forget_facts(conn: &Connection, path: &str) -> Result<(), DbError> {
    for table in ["links", "tags", "aliases"] {
        conn.execute(&format!("DELETE FROM {table} WHERE source = ?1"), [path])?;
    }
    Ok(())
}

/// Stores a note's links, tags, and aliases; its old rows must be gone already.
fn write_facts(conn: &Connection, path: &str, facts: &NoteFacts) -> Result<(), DbError> {
    write_links(conn, path, &facts.links)?;
    let mut tag = conn.prepare("INSERT INTO tags (source, tag, start_byte) VALUES (?1, ?2, ?3)")?;
    for inline in &facts.tags {
        tag.execute(params![
            path,
            inline.tag,
            i64::try_from(inline.range.start).unwrap_or(i64::MAX)
        ])?;
    }
    for front in &facts.front.tags {
        tag.execute(params![path, front, Option::<i64>::None])?;
    }
    let mut alias = conn.prepare("INSERT INTO aliases (source, alias) VALUES (?1, ?2)")?;
    for name in &facts.front.aliases {
        alias.execute(params![path, name])?;
    }
    Ok(())
}

/// Stores a note's links; its old rows must be gone already.
fn write_links(conn: &Connection, path: &str, found: &[Link]) -> Result<(), DbError> {
    let mut insert = conn.prepare(
        "INSERT OR IGNORE INTO links (source, start_byte, end_byte, kind, embed, target, heading, block) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for link in found {
        let (heading, block) = match &link.anchor {
            Some(Anchor::Heading(heading)) => (Some(heading.as_str()), None),
            Some(Anchor::Block(block)) => (None, Some(block.as_str())),
            None => (None, None),
        };
        insert.execute(params![
            path,
            i64::try_from(link.range.start).unwrap_or(i64::MAX),
            i64::try_from(link.range.end).unwrap_or(i64::MAX),
            link.kind.as_str(),
            link.embed,
            link.target,
            heading,
            block,
        ])?;
    }
    Ok(())
}

/// The links stored for one note, in text order.
pub fn stored_links(conn: &Connection, source: &str) -> Result<Vec<Link>, DbError> {
    let mut statement = conn.prepare(
        "SELECT start_byte, end_byte, kind, embed, target, heading, block FROM links \
         WHERE source = ?1 ORDER BY start_byte",
    )?;
    let rows = statement.query_map([source], |row| {
        let start: i64 = row.get(0)?;
        let end: i64 = row.get(1)?;
        let kind: String = row.get(2)?;
        let heading: Option<String> = row.get(5)?;
        let block: Option<String> = row.get(6)?;
        Ok(Link {
            range: usize::try_from(start).unwrap_or(0)..usize::try_from(end).unwrap_or(0),
            kind: if kind == "wiki" {
                LinkKind::Wiki
            } else {
                LinkKind::Markdown
            },
            embed: row.get(3)?,
            target: row.get(4)?,
            anchor: heading
                .map(Anchor::Heading)
                .or_else(|| block.map(Anchor::Block)),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
