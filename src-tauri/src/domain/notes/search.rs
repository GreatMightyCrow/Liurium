//! Search in the open project's notes (M4-001): an FTS5 index in the project's cache,
//! kept current with the notes' links and tags. The index holds no copy of the text
//! (contentless), so excerpts are read from the files when asked, and always show
//! them as they are now. A query is untrusted input and never reaches FTS5 as syntax.

use std::ops::Range;

use rusqlite::{Connection, params};

use super::{
    NoteFacts,
    backlinks::{Backlink, read_text, snippet},
    meta,
};
use crate::storage::{db::DbError, fs::ProjectRoot, fs::RelPath};

/// Longer input is cut here.
pub const MAX_QUERY_CHARS: usize = 200;
pub const MAX_RESULTS: usize = 50;
/// The trigram index needs three characters; shorter words only find names.
pub const MIN_TEXT_WORD: usize = 3;
/// Excerpts stop after this many bytes were read in one search, so many large
/// notes cannot make a search slow; later results come without an excerpt.
const MAX_EXCERPT_BYTES: usize = 20 * 1024 * 1024;

/// What the index gets from one note.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Document {
    /// The file name without `.md`.
    pub name: String,
    pub aliases: String,
    pub headings: String,
    pub tags: String,
    /// The YAML of the properties block, as written.
    pub properties: String,
    /// The text after the properties block.
    pub body: String,
}

impl Document {
    /// `text` is `None` for a note that cannot be read: it is still found by name.
    pub fn of(path: &str, text: Option<&str>, facts: &NoteFacts) -> Self {
        let name = stem(path).to_owned();
        let Some(text) = text else {
            return Self {
                name,
                ..Self::default()
            };
        };
        let body_start = meta::place(text).map_or(0, |place| place.whole.end);
        let tags: Vec<&str> = facts
            .tags
            .iter()
            .map(|tag| tag.tag.as_str())
            .chain(facts.front.tags.iter().map(String::as_str))
            .collect();
        Self {
            name,
            aliases: facts.front.aliases.join("\n"),
            headings: facts.headings.join("\n"),
            tags: tags.join("\n"),
            properties: meta::block(text).unwrap_or_default().to_owned(),
            body: text[body_start..].to_owned(),
        }
    }
}

/// The file name without its folder and its `.md` or `.markdown`.
fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    for ending in [".markdown", ".md"] {
        if name.len() > ending.len()
            && let Some(cut) = name.len().checked_sub(ending.len())
            && name.is_char_boundary(cut)
            && name[cut..].eq_ignore_ascii_case(ending)
        {
            return &name[..cut];
        }
    }
    name
}

/// Adds a note's row; its row in `notes` must exist and its old search row be gone.
pub(super) fn write(conn: &Connection, path: &str, document: &Document) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO search (rowid, name, aliases, headings, tags, properties, body) \
         SELECT rowid, ?2, ?3, ?4, ?5, ?6, ?7 FROM notes WHERE path = ?1",
        params![
            path,
            document.name,
            document.aliases,
            document.headings,
            document.tags,
            document.properties,
            document.body,
        ],
    )?;
    Ok(())
}

/// Removes a note's row, before the note's row in `notes` goes or changes.
pub(super) fn forget(conn: &Connection, path: &str) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM search WHERE rowid = (SELECT rowid FROM notes WHERE path = ?1)",
        [path],
    )?;
    Ok(())
}

/// One note found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub path: String,
    /// The line of the first match in the text; `None` when only its name, aliases,
    /// or properties matched, or the excerpt budget is spent.
    pub excerpt: Option<Backlink>,
}

/// The words of a query: control characters dropped, cut at [`MAX_QUERY_CHARS`],
/// each word once.
pub fn words(input: &str) -> Vec<String> {
    let cleaned: String = input
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_QUERY_CHARS)
        .collect();
    let mut found: Vec<String> = Vec::new();
    for word in cleaned.split_whitespace() {
        if !found.iter().any(|seen| fold_str(seen) == fold_str(word)) {
            found.push(word.to_owned());
        }
    }
    found
}

/// Notes whose name or an alias holds every word come first, shortest name first;
/// then notes whose indexed text holds every word of three or more characters, best
/// first. At most [`MAX_RESULTS`].
pub fn search(conn: &Connection, root: &ProjectRoot, input: &str) -> Result<Vec<Hit>, DbError> {
    let words = words(input);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let folded: Vec<Vec<char>> = words.iter().map(|word| fold_chars(word)).collect();
    let long: Vec<&String> = words
        .iter()
        .filter(|word| word.chars().count() >= MIN_TEXT_WORD)
        .collect();

    let mut paths = by_name(conn, &folded)?;
    if !long.is_empty() {
        let query = long
            .iter()
            .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let mut statement = conn.prepare(
            "SELECT notes.path FROM search JOIN notes ON notes.rowid = search.rowid \
             WHERE search MATCH ?1 \
             ORDER BY bm25(search, 10.0, 8.0, 4.0, 4.0, 2.0, 1.0), notes.path LIMIT ?2",
        )?;
        let limit = i64::try_from(MAX_RESULTS).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![query, limit], |row| row.get::<_, String>(0))?;
        for row in rows {
            let path = row?;
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths.truncate(MAX_RESULTS);

    let long_folded: Vec<Vec<char>> = long.iter().map(|word| fold_chars(word)).collect();
    let mut budget = MAX_EXCERPT_BYTES;
    Ok(paths
        .into_iter()
        .map(|path| {
            let excerpt = if long_folded.is_empty() || budget == 0 {
                None
            } else {
                RelPath::parse(&path)
                    .ok()
                    .and_then(|rel| read_text(root, &rel))
                    .and_then(|text| {
                        budget = budget.saturating_sub(text.len());
                        excerpt(&text, &long_folded)
                    })
            };
            Hit { path, excerpt }
        })
        .collect())
}

/// Whether `name` holds every word, compared as the index compares: without case or
/// accents, also inside words.
pub fn holds_all(name: &str, words: &[String]) -> bool {
    let folded: Vec<Vec<char>> = words.iter().map(|word| fold_chars(word)).collect();
    holds_folded(name, &folded)
}

fn holds_folded(name: &str, folded: &[Vec<char>]) -> bool {
    let name = fold_chars(name);
    folded.iter().all(|word| find(&name, word).is_some())
}

/// Notes whose name or one alias holds every word.
fn by_name(conn: &Connection, folded: &[Vec<char>]) -> Result<Vec<String>, DbError> {
    let holds_all = |name: &str| holds_folded(name, folded);
    let mut found: Vec<(usize, String)> = Vec::new();
    let mut statement = conn.prepare("SELECT path FROM notes")?;
    let paths: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let mut statement = conn.prepare("SELECT source, alias FROM aliases")?;
    let aliases: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for path in paths {
        let name = stem(&path);
        if holds_all(name) {
            found.push((name.chars().count(), path));
        } else if let Some((_, alias)) = aliases
            .iter()
            .find(|(source, alias)| *source == path && holds_all(alias))
        {
            found.push((alias.chars().count(), path));
        }
    }
    found.sort_by_cached_key(|(length, path)| (*length, path.to_lowercase(), path.clone()));
    Ok(found.into_iter().map(|(_, path)| path).collect())
}

/// The line of the first word found in the text after the properties block.
fn excerpt(text: &str, words: &[Vec<char>]) -> Option<Backlink> {
    let body_start = meta::place(text).map_or(0, |place| place.whole.end);
    let body = &text[body_start..];
    let range = words.iter().find_map(|word| find_in(body, word))?;
    Some(snippet(
        text,
        range.start + body_start..range.end + body_start,
    ))
}

/// Where `word` (already folded) first stands in `text`, in bytes.
fn find_in(text: &str, word: &[char]) -> Option<Range<usize>> {
    if word.is_empty() {
        return None;
    }
    for (start, _) in text.char_indices() {
        let mut here = text[start..].char_indices();
        let mut end = start;
        let all = word.iter().all(|wanted| match here.next() {
            Some((at, c)) if fold(c) == *wanted => {
                end = start + at + c.len_utf8();
                true
            }
            _ => false,
        });
        if all {
            return Some(start..end);
        }
    }
    None
}

/// Whether `word` stands in `text`, both folded.
fn find(text: &[char], word: &[char]) -> Option<usize> {
    if word.is_empty() {
        return Some(0);
    }
    text.windows(word.len()).position(|window| window == word)
}

fn fold_chars(text: &str) -> Vec<char> {
    text.chars().map(fold).collect()
}

fn fold_str(text: &str) -> String {
    text.chars().map(fold).collect()
}

/// A character as the index compares it: lower case, Latin letters without their
/// accents (as FTS5's `remove_diacritics`), one character for one, so places in the
/// folded text are places in the text. Letters outside this table only lose case.
fn fold(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    match lower {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' => 'd',
        'è'..='ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' => 'h',
        'ì'..='ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò'..='ö' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' => 't',
        'ù'..='ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other => other,
    }
}
