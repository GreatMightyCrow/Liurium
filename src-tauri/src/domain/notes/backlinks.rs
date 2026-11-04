//! Backlinks (M3-006): the notes whose links lead to a note. The stored links find
//! the source notes; each source is then read and parsed again, so the lines shown
//! match the file as it is now. Nothing is written into notes.

use std::collections::BTreeMap;

use rusqlite::{Connection, TransactionBehavior, params};

use super::{
    links::{self, NoteSet, Target},
    nanos,
    session::MAX_NOTE_BYTES,
    stored_links, text, write_links,
};
use crate::storage::{
    db::DbError,
    fs::{FsError, ProjectRoot, RelPath},
};

/// About this many characters of the line are shown on each side of the link.
const CONTEXT_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlink {
    /// Where the link starts in the source note's text, in UTF-16 units.
    pub offset: usize,
    /// The line around the link, shortened with "…" when long.
    pub line: String,
    /// The link inside `line`, in UTF-16 units.
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkSource {
    pub path: String,
    pub links: Vec<Backlink>,
}

fn leads_to(target: &Target, path: &str) -> bool {
    matches!(target, Target::Note { path: found } if found.to_lowercase() == path.to_lowercase())
}

/// Every other note that links to `target`, sorted by path.
pub fn backlinks(
    conn: &Connection,
    root: &ProjectRoot,
    set: &NoteSet,
    target: &RelPath,
) -> Result<Vec<BacklinkSource>, DbError> {
    let wanted = target.to_string();
    let sources: Vec<String> = {
        let mut statement = conn.prepare("SELECT DISTINCT source FROM links ORDER BY source")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut found = BTreeMap::new();
    for source in sources {
        if source.to_lowercase() == wanted.to_lowercase() {
            continue;
        }
        let Ok(source_path) = RelPath::parse(&source) else {
            continue;
        };
        let candidate = stored_links(conn, &source)?
            .iter()
            .any(|link| leads_to(&links::resolve(&source_path, link, set), &wanted));
        if !candidate {
            continue;
        }
        let Some(note) = read_text(root, &source_path) else {
            continue;
        };
        let lines: Vec<Backlink> = links::parse(&note)
            .iter()
            .filter(|link| leads_to(&links::resolve(&source_path, link, set), &wanted))
            .map(|link| snippet(&note, link.range.clone()))
            .collect();
        if !lines.is_empty() {
            found.insert(
                source.to_lowercase(),
                BacklinkSource {
                    path: source,
                    links: lines,
                },
            );
        }
    }
    Ok(found.into_values().collect())
}

fn read_text(root: &ProjectRoot, path: &RelPath) -> Option<String> {
    let (bytes, _) = root.read(path, MAX_NOTE_BYTES).ok()?;
    text::decode(&bytes).ok().map(|note| note.text)
}

/// The line around a link, with the link's place in it.
fn snippet(text: &str, link: std::ops::Range<usize>) -> Backlink {
    let line_start = text[..link.start].rfind('\n').map_or(0, |at| at + 1);
    let line_end = text[link.end..]
        .find(['\r', '\n'])
        .map_or(text.len(), |at| link.end + at);
    let before: Vec<(usize, char)> = text[line_start..link.start].char_indices().collect();
    let start = if before.len() > CONTEXT_CHARS {
        line_start + before[before.len() - CONTEXT_CHARS].0
    } else {
        line_start
    };
    let end = text[link.end..line_end]
        .char_indices()
        .nth(CONTEXT_CHARS)
        .map_or(line_end, |(at, _)| link.end + at);
    let lead = if start > line_start { "…" } else { "" };
    let tail = if end < line_end { "…" } else { "" };
    let line = format!("{lead}{}{tail}", &text[start..end]);
    let units = |part: &str| part.encode_utf16().count();
    let from = units(lead) + units(&text[start..link.start]);
    let offsets = links::utf16_offsets(text, &[link.start]);
    Backlink {
        offset: offsets[0],
        from,
        to: from + units(&text[link.clone()]),
        line,
    }
}

/// Brings the stored links of notes saved in Liurium up to date: their stamp and
/// links from the file as it is now; a note that is gone loses its row.
pub fn refresh_notes(
    conn: &mut Connection,
    root: &ProjectRoot,
    paths: &[RelPath],
) -> Result<(), DbError> {
    let mut fresh = Vec::new();
    for path in paths {
        let stamp = match root.stamp(path) {
            Ok(stamp) => Some(stamp),
            Err(FsError::NotFound) => None,
            Err(_) => continue,
        };
        let found = read_text(root, path).map_or_else(Vec::new, |note| links::parse(&note));
        fresh.push((path.to_string(), stamp, found));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (path, stamp, found) in &fresh {
        match stamp {
            Some(stamp) => {
                tx.execute(
                    "INSERT INTO notes (path, size, modified_ns) VALUES (?1, ?2, ?3) \
                     ON CONFLICT (path) DO UPDATE SET size = ?2, modified_ns = ?3",
                    params![
                        path,
                        i64::try_from(stamp.len).unwrap_or(i64::MAX),
                        nanos(stamp.modified)
                    ],
                )?;
                tx.execute("DELETE FROM links WHERE source = ?1", [path])?;
                write_links(&tx, path, found)?;
            }
            None => {
                tx.execute("DELETE FROM notes WHERE path = ?1", [path])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
#[path = "backlinks_tests.rs"]
mod tests;
