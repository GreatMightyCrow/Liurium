//! The properties box (M3-015): a note's front matter as named values, and edits to
//! them as plain text changes. Nothing here touches a file: an edit takes the note's
//! text and returns the new text, which then saves like typing.
//!
//! Only an entry's own lines change, so comments, order, and other entries stay byte
//! for byte. The result is read again; if any value is not what was asked for, the
//! edit is refused rather than guessed.

use std::{collections::HashSet, ops::Range};

use serde::{Deserialize, Serialize};

use super::links::valid_tag;
use super::meta::{self, Node};

/// Longest property name, in characters.
pub const MAX_NAME_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "PropertyValue.ts"))]
pub enum Value {
    Empty,
    Text {
        text: String,
    },
    Number {
        text: String,
    },
    Checkbox {
        checked: bool,
    },
    Date {
        text: String,
    },
    DateTime {
        text: String,
    },
    List {
        items: Vec<String>,
    },
    /// More than the box can show or change safely: shown as written, never edited.
    AsText {
        source: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub value: Value,
    /// The entry's lines in the YAML, from 0.
    lines: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum View {
    /// No block at the start of the note.
    None,
    /// A block the box cannot show safely; it stays visible as text.
    AsText,
    Fields {
        /// The whole block in the text, in bytes.
        range: Range<usize>,
        fields: Vec<Field>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "PropertyEdit.ts"))]
pub enum Edit {
    /// Changes a property, or adds it at the end of the block.
    Set {
        name: String,
        value: Value,
    },
    Rename {
        name: String,
        to: String,
    },
    Remove {
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditError {
    InvalidName,
    /// The new name is already used in this note.
    NameTaken,
    InvalidTag,
    /// Not possible without risking something else in the note.
    Refused,
}

const LIST_KEYS: [&str; 4] = ["tags", "tag", "aliases", "alias"];
const SPLIT_KEYS: [&str; 2] = ["tags", "tag"];

fn digits(text: &str, count: usize) -> bool {
    text.len() == count && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn in_range(text: &str, low: u32, high: u32) -> bool {
    text.parse()
        .is_ok_and(|value: u32| (low..=high).contains(&value))
}

fn is_date(text: &str) -> bool {
    let mut parts = text.split('-');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(year), Some(month), Some(day), None) => {
            digits(year, 4)
                && digits(month, 2)
                && digits(day, 2)
                && in_range(month, 1, 12)
                && in_range(day, 1, 31)
        }
        _ => false,
    }
}

fn is_date_time(text: &str) -> bool {
    let Some((date, time)) = text.split_once('T') else {
        return false;
    };
    let parts: Vec<&str> = time.split(':').collect();
    is_date(date)
        && matches!(parts.len(), 2 | 3)
        && parts.iter().all(|part| digits(part, 2))
        && in_range(parts[0], 0, 23)
        && parts[1..].iter().all(|part| in_range(part, 0, 59))
}

/// Plain decimal numbers only; YAML's `0x10` or `.inf` stay text.
fn is_number(text: &str) -> bool {
    let bare = text.strip_prefix('-').unwrap_or(text);
    let mut parts = bare.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    parts.next().is_none()
        && !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction
            .is_none_or(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn scalar_value(value: &str, plain: bool) -> Option<Value> {
    if value.contains('\n') {
        return None;
    }
    let text = || value.to_owned();
    if !plain {
        return Some(Value::Text { text: text() });
    }
    Some(match value {
        "" | "~" | "null" | "Null" | "NULL" => Value::Empty,
        "true" | "True" | "TRUE" => Value::Checkbox { checked: true },
        "false" | "False" | "FALSE" => Value::Checkbox { checked: false },
        _ if is_number(value) => Value::Number { text: text() },
        _ if is_date(value) => Value::Date { text: text() },
        _ if is_date_time(value) => Value::DateTime { text: text() },
        _ => Value::Text { text: text() },
    })
}

/// A lone `#` after a space starts a comment, also in what a list item holds, so a
/// list with one cannot be rewritten without losing it.
fn has_comment(lines: &[&str]) -> bool {
    lines.iter().any(|line| {
        let bare = line.trim_end_matches(['\r', '\n']);
        bare.trim_start().starts_with('#') || bare.contains(" #")
    })
}

fn node_value(name: &str, node: &Node, lines: &[&str]) -> Option<Value> {
    if !lines.first()?.starts_with(&format!("{name}:")) {
        return None;
    }
    let lower = name.to_lowercase();
    let listed = LIST_KEYS.contains(&lower.as_str());
    let single_line = lines.len() == 1;
    match node {
        Node::Scalar { value, plain } if listed => {
            let split = SPLIT_KEYS.contains(&lower.as_str());
            let empty = *plain && value.is_empty();
            (single_line && !value.contains('\n')).then(|| Value::List {
                items: if empty {
                    Vec::new()
                } else {
                    meta::texts(node, split)
                        .into_iter()
                        .filter(|item| !item.is_empty())
                        .collect()
                },
            })
        }
        Node::Scalar { value, plain } => {
            if single_line {
                scalar_value(value, *plain)
            } else {
                None
            }
        }
        Node::Sequence(items) => {
            let flat = items
                .iter()
                .all(|item| matches!(item, Node::Scalar { value, .. } if !value.contains('\n')));
            (flat && !has_comment(lines)).then(|| Value::List {
                items: meta::texts(node, false),
            })
        }
        Node::Mapping(_) | Node::Skipped => None,
    }
}

/// A blank line or a comment at the start of a line, between two entries.
fn between_entries(line: &str) -> bool {
    line.starts_with('#') || line.trim().is_empty()
}

fn fields_of(yaml: &str) -> Option<Vec<Field>> {
    let parsed = meta::parse(yaml)?;
    if parsed.linked {
        return None;
    }
    let entries = match parsed.top {
        None => return Some(Vec::new()),
        Some(Node::Mapping(entries)) => entries,
        Some(_) => return None,
    };
    if parsed.key_lines.len() != entries.len() / 2
        || parsed.key_lines.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return None;
    }
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let mut seen = HashSet::new();
    let mut fields = Vec::with_capacity(parsed.key_lines.len());
    for (index, pair) in entries.as_chunks::<2>().0.iter().enumerate() {
        let [Node::Scalar { value: name, .. }, node] = pair else {
            return None;
        };
        if !seen.insert(name.clone()) {
            return None;
        }
        let start = parsed.key_lines[index].checked_sub(1)?;
        let mut end = parsed
            .key_lines
            .get(index + 1)
            .map_or(lines.len(), |next| next - 1);
        while end > start + 1 && between_entries(lines[end - 1]) {
            end -= 1;
        }
        let own = lines.get(start..end)?;
        if own.first()?.starts_with(char::is_whitespace) {
            return None;
        }
        let value = node_value(name, node, own).unwrap_or_else(|| Value::AsText {
            source: own.concat().trim_end().replace("\r\n", "\n"),
        });
        fields.push(Field {
            name: name.clone(),
            value,
            lines: start..end,
        });
    }
    Some(fields)
}

/// How a note's front matter shows.
pub fn read(text: &str) -> View {
    let Some(place) = meta::place(text) else {
        return View::None;
    };
    match fields_of(&text[place.yaml]) {
        Some(fields) => View::Fields {
            range: place.whole,
            fields,
        },
        None => View::AsText,
    }
}

/// What a name may be: readable as a key without quotes.
fn valid_name(name: &str) -> bool {
    name.chars().count() <= MAX_NAME_CHARS
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        && !name.ends_with(' ')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.' | '/'))
}

/// Words other YAML readers may take as yes or no.
const OLD_BOOLEANS: [&str; 6] = ["y", "n", "yes", "no", "on", "off"];

fn can_be_plain(text: &str) -> bool {
    let first = text.chars().next();
    let reserved = first.is_none_or(|c| "-?:,[]{}#&*!|>'\"%@`".contains(c) || c.is_whitespace());
    if reserved
        || text.ends_with(char::is_whitespace)
        || text.chars().any(char::is_control)
        || OLD_BOOLEANS.contains(&text.to_lowercase().as_str())
    {
        return false;
    }
    let yaml = format!("k: {text}\n");
    let Some(parsed) = meta::parse(&yaml) else {
        return false;
    };
    let Some(Node::Mapping(entries)) = parsed.top else {
        return false;
    };
    match entries.as_slice() {
        [_, Node::Scalar { value, plain: true }] => {
            value == text
                && scalar_value(value, true)
                    == Some(Value::Text {
                        text: text.to_owned(),
                    })
        }
        _ => false,
    }
}

fn scalar(text: &str) -> String {
    if can_be_plain(text) {
        return text.to_owned();
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            c if c.is_control() => quoted.push_str(&format!("\\u{:04X}", u32::from(c))),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// The comment after a value on its one line, with the spaces before it.
fn trailing_comment(line: &str) -> &str {
    let bare = line.trim_end_matches(['\r', '\n']);
    let Some((_, after_key)) = bare.split_once(':') else {
        return "";
    };
    let value_at = bare.len() - after_key.len();
    let value = after_key.trim_start();
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'');
    let mut from = 0;
    if let Some(quote) = quote {
        // Past the closing quote; an escaped quote only makes this stop too early, and
        // the comment then found is checked with the rest by reading the result again.
        let Some(close) = value[1..].rfind(quote) else {
            return "";
        };
        from = close + 2;
    }
    let start = value_at + (after_key.len() - value.len()) + from;
    let rest = &bare[start..];
    let found = if rest.starts_with('#') {
        Some(0)
    } else {
        rest.find(" #").map(|at| at + 1)
    };
    let Some(hash) = found else {
        return "";
    };
    let at = start + hash;
    &bare[bare[..at].trim_end().len()..]
}

/// The lines of one entry, in the note's line endings.
fn entry_source(name: &str, value: &Value, comment: &str, eol: &str) -> Result<String, EditError> {
    let one = |text: String| {
        Ok(if text.is_empty() {
            format!("{name}:{comment}{eol}")
        } else {
            format!("{name}: {text}{comment}{eol}")
        })
    };
    match value {
        Value::Empty => one(String::new()),
        Value::Text { text } => one(scalar(text)),
        Value::Number { text } if is_number(text) => one(text.clone()),
        Value::Date { text } if is_date(text) => one(text.clone()),
        Value::DateTime { text } if is_date_time(text) => one(text.clone()),
        Value::Checkbox { checked } => one(checked.to_string()),
        // A list keeps no comment (reading one back shows it as written), so turning a
        // commented value into a list would lose the comment.
        Value::List { .. } if !comment.is_empty() => Err(EditError::Refused),
        Value::List { items } if items.is_empty() => one("[]".to_owned()),
        Value::List { items } => {
            let mut source = format!("{name}:{eol}");
            for item in items {
                source.push_str(&format!("  - {}{eol}", scalar(item)));
            }
            Ok(source)
        }
        Value::Number { .. }
        | Value::Date { .. }
        | Value::DateTime { .. }
        | Value::AsText { .. } => Err(EditError::Refused),
    }
}

fn line_ending(text: &str) -> &'static str {
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

fn pairs(fields: &[Field]) -> Vec<(String, Value)> {
    fields
        .iter()
        .map(|field| (field.name.clone(), field.value.clone()))
        .collect()
}

fn new_tags_are_valid(name: &str, value: &Value, old: Option<&Value>) -> bool {
    if !SPLIT_KEYS.contains(&name.to_lowercase().as_str()) {
        return true;
    }
    let Value::List { items } = value else {
        return true;
    };
    let known: &[String] = match old {
        Some(Value::List { items }) => items,
        _ => &[],
    };
    items
        .iter()
        .all(|item| known.contains(item) || valid_tag(item))
}

/// Applies one edit to a note's text; refused edits leave nothing changed.
pub fn edit(text: &str, edit: &Edit) -> Result<String, EditError> {
    let eol = line_ending(text);
    let Some(place) = meta::place(text) else {
        let Edit::Set { name, value } = edit else {
            return Err(EditError::Refused);
        };
        if !valid_name(name) {
            return Err(EditError::InvalidName);
        }
        if !new_tags_are_valid(name, value, None) {
            return Err(EditError::InvalidTag);
        }
        let entry = entry_source(name, value, "", eol)?;
        let new = format!("---{eol}{entry}---{eol}{text}");
        return checked(new, text, &[(name.clone(), value.clone())]);
    };
    let body = &text[place.whole.end..];
    let yaml = &text[place.yaml.clone()];
    let fields = fields_of(yaml).ok_or(EditError::Refused)?;
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let find = |name: &str| fields.iter().position(|field| field.name == name);
    let mut expected = pairs(&fields);
    let mut new_lines: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();

    match edit {
        Edit::Set { name, value } => {
            if !valid_name(name) {
                return Err(EditError::InvalidName);
            }
            match find(name) {
                Some(index) => {
                    let field = &fields[index];
                    if matches!(field.value, Value::AsText { .. }) {
                        return Err(EditError::Refused);
                    }
                    if !new_tags_are_valid(name, value, Some(&field.value)) {
                        return Err(EditError::InvalidTag);
                    }
                    let comment = if field.lines.len() == 1 {
                        trailing_comment(lines[field.lines.start])
                    } else {
                        ""
                    };
                    let entry = entry_source(name, value, comment, eol)?;
                    new_lines.splice(field.lines.clone(), [entry]);
                    expected[index].1 = value.clone();
                }
                None => {
                    if !new_tags_are_valid(name, value, None) {
                        return Err(EditError::InvalidTag);
                    }
                    new_lines.push(entry_source(name, value, "", eol)?);
                    expected.push((name.clone(), value.clone()));
                }
            }
        }
        Edit::Rename { name, to } => {
            if !valid_name(to) {
                return Err(EditError::InvalidName);
            }
            if name == to {
                return Ok(text.to_owned());
            }
            if find(to).is_some() {
                return Err(EditError::NameTaken);
            }
            let index = find(name).ok_or(EditError::Refused)?;
            let field = &fields[index];
            if matches!(field.value, Value::AsText { .. }) {
                return Err(EditError::Refused);
            }
            let line = lines[field.lines.start];
            let rest = line.strip_prefix(name.as_str()).ok_or(EditError::Refused)?;
            new_lines[field.lines.start] = format!("{to}{rest}");
            expected[index].0.clone_from(to);
        }
        Edit::Remove { name } => {
            let index = find(name).ok_or(EditError::Refused)?;
            let field = &fields[index];
            if matches!(field.value, Value::AsText { .. }) {
                return Err(EditError::Refused);
            }
            new_lines.splice(field.lines.clone(), []);
            expected.remove(index);
        }
    }

    let new = format!(
        "{}{}{}",
        &text[..place.yaml.start],
        new_lines.concat(),
        &text[place.yaml.end..]
    );
    checked_with_body(new, body, &expected)
}

/// Reads the result again: the body untouched, every value what was asked for.
fn checked_with_body(
    new: String,
    body: &str,
    expected: &[(String, Value)],
) -> Result<String, EditError> {
    match read(&new) {
        View::Fields { range, fields }
            if &new[range.end..] == body && pairs(&fields) == expected =>
        {
            Ok(new)
        }
        _ => Err(EditError::Refused),
    }
}

fn checked(new: String, body: &str, expected: &[(String, Value)]) -> Result<String, EditError> {
    checked_with_body(new, body, expected)
}

#[cfg(test)]
#[path = "properties_tests.rs"]
mod tests;
