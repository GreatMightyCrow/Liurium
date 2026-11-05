//! Front matter (M3-007, ADR-0020): the YAML block at the very start of a note.
//! Only `tags`/`tag` and `aliases`/`alias` are read. The block is untrusted: at most
//! 64 KB, read event by event with `yaml-rust2`'s parser (its `load` recurses, so it
//! is not used), nesting deeper than 32 or more than 10 000 events stop it, and
//! aliases are never expanded. Any problem leaves the note without front matter data.

use std::ops::Range;

use yaml_rust2::{
    parser::{Event, Parser},
    scanner::TScalarStyle,
};

use super::links::valid_tag;

const MAX_BYTES: usize = 64 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_EVENTS: usize = 10_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrontMatter {
    /// Without `#`, as written.
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

/// Where a front matter block lies in a note's text, in bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockPlace {
    /// The YAML between the two marker lines.
    pub yaml: Range<usize>,
    /// The whole block with both marker lines and the last line's break.
    pub whole: Range<usize>,
}

/// The block from the opening `---` on the first line to the next line that is `---`
/// or `...`; `None` without a closed block at the very start.
pub fn place(text: &str) -> Option<BlockPlace> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    let start = first.len();
    let mut at = start;
    for line in lines {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare == "---" || bare == "..." {
            return Some(BlockPlace {
                yaml: start..at,
                whole: 0..at + line.len(),
            });
        }
        at += line.len();
    }
    None
}

/// The YAML of the block at the very start of a note.
pub fn block(text: &str) -> Option<&str> {
    place(text).map(|place| &text[place.yaml])
}

pub(super) enum Node {
    Scalar {
        value: String,
        /// Written without quotes, so `12` and `true` mean a number and a yes or no.
        plain: bool,
    },
    Sequence(Vec<Node>),
    Mapping(Vec<Node>),
    /// An alias or anything else not read.
    Skipped,
}

/// A document read within the limits.
pub(super) struct Parsed {
    pub top: Option<Node>,
    /// The line (from 1) of each key of a mapping at the top, in order.
    pub key_lines: Vec<usize>,
    /// It uses anchors, aliases, or explicit tags, so a line cannot be judged alone.
    pub linked: bool,
}

/// The first document's top value, built without recursion and within the limits.
fn top_value(yaml: &str) -> Option<Node> {
    parse(yaml)?.top
}

pub(super) fn parse(yaml: &str) -> Option<Parsed> {
    if yaml.len() > MAX_BYTES {
        return None;
    }
    let mut parser = Parser::new_from_str(yaml);
    let mut open: Vec<Node> = Vec::new();
    let mut top = None;
    let mut key_lines = Vec::new();
    let mut linked = false;
    for _ in 0..MAX_EVENTS {
        let (event, marker) = parser.next_token().ok()?;
        if !matches!(event, Event::MappingEnd)
            && let [Node::Mapping(items)] = open.as_slice()
            && items.len() % 2 == 0
        {
            key_lines.push(marker.line());
        }
        let done = match event {
            Event::Scalar(value, style, anchor, tag) => {
                linked |= anchor != 0 || tag.is_some();
                Some(Node::Scalar {
                    value,
                    plain: matches!(style, TScalarStyle::Plain),
                })
            }
            Event::Alias(_) => {
                linked = true;
                Some(Node::Skipped)
            }
            Event::SequenceStart(anchor, ref tag) | Event::MappingStart(anchor, ref tag) => {
                linked |= anchor != 0 || tag.is_some();
                if open.len() >= MAX_DEPTH {
                    return None;
                }
                open.push(if matches!(event, Event::SequenceStart(..)) {
                    Node::Sequence(Vec::new())
                } else {
                    Node::Mapping(Vec::new())
                });
                None
            }
            Event::SequenceEnd | Event::MappingEnd => Some(open.pop()?),
            Event::DocumentEnd | Event::StreamEnd => {
                return Some(Parsed {
                    top,
                    key_lines,
                    linked,
                });
            }
            Event::Nothing | Event::StreamStart | Event::DocumentStart => None,
        };
        if let Some(node) = done {
            match open.last_mut() {
                Some(Node::Sequence(items) | Node::Mapping(items)) => items.push(node),
                Some(_) => return None,
                None => top = Some(node),
            }
        }
    }
    None
}

pub(super) fn texts(node: &Node, split: bool) -> Vec<String> {
    match node {
        Node::Scalar { value, .. } if split => value
            .split(|c: char| c == ',' || c.is_whitespace())
            .map(str::to_owned)
            .collect(),
        Node::Scalar { value, .. } => vec![value.clone()],
        Node::Sequence(items) => items
            .iter()
            .filter_map(|item| match item {
                Node::Scalar { value, .. } => Some(value.clone()),
                _ => None,
            })
            .collect(),
        Node::Mapping(_) | Node::Skipped => Vec::new(),
    }
}

/// Tags and aliases from a note's front matter; empty when there is none or it
/// cannot be read.
pub fn read(text: &str) -> FrontMatter {
    let Some(Node::Mapping(entries)) = block(text).and_then(top_value) else {
        return FrontMatter::default();
    };
    let mut meta = FrontMatter::default();
    for pair in entries.chunks(2) {
        let [Node::Scalar { value: key, .. }, value] = pair else {
            continue;
        };
        match key.as_str() {
            "tags" | "tag" => meta.tags.extend(
                texts(value, true)
                    .into_iter()
                    .map(|tag| tag.trim().trim_start_matches('#').to_owned())
                    .filter(|tag| valid_tag(tag)),
            ),
            "aliases" | "alias" => meta.aliases.extend(
                texts(value, false)
                    .into_iter()
                    .map(|alias| alias.trim().to_owned())
                    .filter(|alias| !alias.is_empty()),
            ),
            _ => {}
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(text: &str) -> (Vec<String>, Vec<String>) {
        let found = read(text);
        (found.tags, found.aliases)
    }

    fn strs(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn lists_texts_and_single_values_are_read() {
        assert_eq!(
            meta(
                "---\ntags: [projekt, '#idee', topic/sub]\naliases:\n  - Roadmap\n  - Plan 2027\nstatus: open\n---\n# Body"
            ),
            (
                strs(&["projekt", "idee", "topic/sub"]),
                strs(&["Roadmap", "Plan 2027"])
            )
        );
        assert_eq!(
            meta("---\ntags: a, b c\nalias: One name\n---\n"),
            (strs(&["a", "b", "c"]), strs(&["One name"]))
        );
        assert_eq!(
            meta("---\r\ntag: solo\r\n---\r\n"),
            (strs(&["solo"]), strs(&[]))
        );
    }

    #[test]
    fn invalid_tags_and_other_shapes_are_left_out() {
        assert_eq!(
            meta("---\ntags: [2026, ok, 'two words', {nested: x}]\naliases: {a: b}\n---\n"),
            (strs(&["ok"]), strs(&[]))
        );
    }

    #[test]
    fn only_a_closed_block_at_the_very_start_counts() {
        assert_eq!(
            meta("# Title\n---\ntags: [x]\n---\n"),
            (strs(&[]), strs(&[]))
        );
        assert_eq!(meta("---\ntags: [x]\nno end"), (strs(&[]), strs(&[])));
        assert_eq!(meta(" ---\ntags: [x]\n---\n"), (strs(&[]), strs(&[])));
    }

    #[test]
    fn broken_deep_huge_or_alias_tricks_give_nothing_and_never_panic() {
        assert_eq!(meta("---\ntags: [unclosed\n---\n"), (strs(&[]), strs(&[])));
        let deep = format!(
            "---\ntags: {}x{}\n---\n",
            "[".repeat(10_000),
            "]".repeat(10_000)
        );
        assert_eq!(meta(&deep), (strs(&[]), strs(&[])));
        let huge = format!("---\ntags: [x]\nfill: '{}'\n---\n", "a".repeat(70 * 1024));
        assert_eq!(meta(&huge), (strs(&[]), strs(&[])));
        let laughs = "---\na: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b]\ntags: *a\n---\n";
        assert_eq!(meta(laughs), (strs(&[]), strs(&[])));
    }
}
