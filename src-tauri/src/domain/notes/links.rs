//! Links between notes (M3-005, ADR-0020): found with `pulldown-cmark`, the one
//! Markdown parser, and resolved against the project's notes. Link text is
//! untrusted: nothing here touches a file, and a target that leaves the project,
//! names `.liurium` or `.git`, or has a scheme is never a note link.

use std::{collections::HashMap, ops::Range};

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};

use super::external::{
    bare_address_end, bare_address_start, checked_address, claimed_other_address,
};
use super::images::{ImageLink, image_of};
use super::organize::is_note_name;
use crate::storage::fs::{RelPath, SKIPPED_FOLDERS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[target]]`, `[[target|text]]`, `![[target]]`.
    Wiki,
    /// `[text](path.md)`, also reference links.
    Markdown,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wiki => "wiki",
            Self::Markdown => "markdown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    /// `#Heading`; for Markdown links the fragment as written (`next-steps`).
    Heading(String),
    /// `#^id`.
    Block(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Bytes of the whole link in the note's text.
    pub range: Range<usize>,
    pub kind: LinkKind,
    pub embed: bool,
    /// Without the anchor; empty for a link to a place in the same note. Markdown
    /// targets are percent-decoded.
    pub target: String,
    pub anchor: Option<Anchor>,
}

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
        | Options::ENABLE_WIKILINKS
}

/// An inline `#tag` (M3-007): its bytes in the text, `#` included, and the tag
/// without it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineTag {
    pub range: Range<usize>,
    pub tag: String,
}

/// What one pass over a note's text found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    pub links: Vec<Link>,
    pub tags: Vec<InlineTag>,
    pub external: Vec<ExternalLink>,
    /// Images to show (M3-013); shown in the editor, not kept in the cache.
    pub images: Vec<ImageLink>,
    /// Formulas to show (M3-010); shown in the editor, not kept in the cache.
    pub math: Vec<MathSpan>,
    /// The text of each heading, in order (M4-001, for search).
    pub headings: Vec<String>,
}

/// A longer formula stays source text: this caps the work per formula (M3-010).
pub const MAX_FORMULA_BYTES: usize = 10_000;

/// A formula (M3-010): `$…$` or `$$…$$`. Its text is untrusted and only ever goes to
/// the page's formula renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MathSpan {
    /// Bytes of the whole formula in the note's text, its `$` included.
    pub range: Range<usize>,
    /// Without the `$`, as the parser read it: `$a\|b$` in a table is `a|b`.
    pub tex: String,
    pub display: bool,
}

/// A link that leaves Liurium (M3-012): never a note link, not kept in the cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalLink {
    /// Bytes of the whole link in the note's text.
    pub range: Range<usize>,
    /// Checked and normalized; this is what opens.
    pub address: String,
    /// The visible text, when it claims another address than this one.
    pub claims: Option<String>,
}

/// An external link's target, if its form and address allow one.
fn external_address(link_type: LinkType, dest: &str) -> Option<String> {
    match link_type {
        LinkType::Inline
        | LinkType::Reference
        | LinkType::Collapsed
        | LinkType::Shortcut
        | LinkType::Autolink => checked_address(dest),
        LinkType::Email => checked_address(&format!("mailto:{dest}")),
        _ => None,
    }
}

/// Every note link in a note's text, in order.
pub fn parse(text: &str) -> Vec<Link> {
    scan(text).links
}

/// Whether a text is a tag (ADR-0020, M3-007): letters, digits, `_`, `-`, `/`,
/// at least one that is not a digit, no `/` at either end.
pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && !tag.starts_with('/')
        && !tag.ends_with('/')
        && tag
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
        && tag.chars().any(|c| !c.is_ascii_digit() && c != '/')
}

/// Tags in one piece of plain text that starts at `offset` in the note.
fn tags_in(piece: &str, offset: usize, before: Option<char>, tags: &mut Vec<InlineTag>) {
    // The character before the piece in the file: a backslash there escaped the `#`.
    let mut previous: Option<char> = before;
    let mut chars = piece.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let starts = c == '#'
            && previous.is_none_or(|before| {
                !(before.is_alphanumeric() || matches!(before, '#' | '/' | '_' | '&' | '\\'))
            });
        previous = Some(c);
        if !starts {
            continue;
        }
        let begin = at + 1;
        let mut end = begin;
        while let Some(&(next_at, next)) = chars.peek() {
            if next.is_alphanumeric() || matches!(next, '_' | '-' | '/') {
                end = next_at + next.len_utf8();
                previous = Some(next);
                chars.next();
            } else {
                break;
            }
        }
        let tag = piece[begin..end].trim_end_matches('/');
        if valid_tag(tag) {
            tags.push(InlineTag {
                range: offset + at..offset + begin + tag.len(),
                tag: tag.to_owned(),
            });
        }
    }
}

/// Links and inline tags of a note's text in one pass of the parser.
pub fn scan(text: &str) -> Scan {
    let body_start = front_matter_end(text);
    let body = &text[body_start..];
    let mut links = Vec::new();
    let mut tags = Vec::new();
    let mut external: Vec<ExternalLink> = Vec::new();
    let mut images: Vec<ImageLink> = Vec::new();
    let mut math: Vec<MathSpan> = Vec::new();
    let mut headings: Vec<String> = Vec::new();
    // The text of the heading being read.
    let mut heading: Option<String> = None;
    // Images inside the one being read; only the outermost shows, the rest is its text.
    let mut image_depth = 0_usize;
    // The text of the outermost image, for as long as it is being read.
    let mut image_text: Option<String> = None;
    let mut code: Vec<Range<usize>> = Vec::new();
    let mut in_code_block = false;
    // Inside a link or image a bare address is that link's text, not a link of its own.
    let mut in_link = 0_usize;
    // The visible text of the external link being read.
    let mut visible: Option<String> = None;
    // A bare address is read from the file, so it can reach past this piece.
    let mut bare_until = 0_usize;
    for (event, range) in Parser::new_ext(body, options()).into_offset_iter() {
        let range = range.start + body_start..range.end + body_start;
        if let Some(visible) = &mut visible
            && let Event::Text(piece) | Event::Code(piece) = &event
        {
            visible.push_str(piece);
        }
        if let Some(image_text) = &mut image_text
            && let Event::Text(piece) | Event::Code(piece) = &event
        {
            image_text.push_str(piece);
        }
        if let Some(heading) = &mut heading
            && let Event::Text(piece) | Event::Code(piece) = &event
        {
            heading.push_str(piece);
        }
        match event {
            Event::Code(_) => code.push(range),
            Event::InlineMath(tex) => {
                code.push(range.clone());
                // As in Obsidian: `$5-$6` is two prices, not a formula.
                let before_digit = text[range.end..]
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_ascii_digit());
                if image_depth == 0 && !before_digit {
                    push_formula(&mut math, range, &tex, false);
                }
            }
            Event::DisplayMath(tex) => {
                code.push(range.clone());
                if image_depth == 0 {
                    push_formula(&mut math, range, &tex, true);
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                code.push(range);
            }
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Heading { .. }) => heading = Some(String::new()),
            Event::End(TagEnd::Heading(_)) => {
                if let Some(done) = heading.take()
                    && !done.trim().is_empty()
                {
                    headings.push(done.trim().to_owned());
                }
            }
            // Only text that is exactly what the file holds there: escapes and
            // entities come as their own pieces, so `\#x` is no tag.
            Event::Text(piece) if !in_code_block && text.get(range.clone()) == Some(&*piece) => {
                let before = text[..range.start].chars().next_back();
                tags_in(&piece, range.start, before, &mut tags);
                if in_link == 0 {
                    let mut from = bare_until.saturating_sub(range.start);
                    while from < piece.len()
                        && let Some(at) = bare_address_start(&piece, from, before)
                    {
                        let start = range.start + at;
                        let end = bare_address_end(text, start);
                        if let Some(address) = text.get(start..end).and_then(checked_address) {
                            external.push(ExternalLink {
                                range: start..end,
                                address,
                                claims: None,
                            });
                        }
                        bare_until = end;
                        from = end.saturating_sub(range.start).max(at + 1);
                    }
                }
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                in_link += 1;
                if let Some(address) = external_address(link_type, &dest_url) {
                    external.push(ExternalLink {
                        range,
                        address,
                        claims: None,
                    });
                    visible = Some(String::new());
                } else if let Some(link) = link_of(link_type, &dest_url, range, false) {
                    links.push(link);
                }
            }
            Event::End(TagEnd::Link) => {
                in_link = in_link.saturating_sub(1);
                if let Some(shown) = visible.take()
                    && let Some(link) = external.last_mut()
                {
                    link.claims = claimed_other_address(&shown, &link.address);
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) => {
                in_link += 1;
                image_depth += 1;
                if image_depth == 1
                    && let Some(image) = image_of(link_type, &dest_url, range.clone())
                {
                    images.push(image);
                    image_text = Some(String::new());
                }
                if matches!(link_type, LinkType::WikiLink { .. })
                    && let Some(link) = link_of(link_type, &dest_url, range, true)
                {
                    links.push(link);
                }
            }
            Event::End(TagEnd::Image) => {
                in_link = in_link.saturating_sub(1);
                image_depth = image_depth.saturating_sub(1);
                if image_depth == 0
                    && let Some(written) = image_text.take()
                    && let Some(image) = images.last_mut()
                {
                    image.set_text(&written);
                }
            }
            _ => {}
        }
    }
    let comments = comments(text, body_start, &code);
    let outside = |range: &Range<usize>| {
        !comments
            .iter()
            .any(|comment| comment.contains(&range.start))
    };
    links.retain(|link| outside(&link.range));
    tags.retain(|tag| outside(&tag.range));
    external.retain(|link| outside(&link.range));
    images.retain(|image| outside(&image.range));
    math.retain(|formula| outside(&formula.range));
    // A `#` inside an address is its fragment, not a tag.
    tags.retain(|tag| {
        !external
            .iter()
            .any(|link| link.range.contains(&tag.range.start))
    });
    Scan {
        links,
        tags,
        external,
        images,
        math,
        headings,
    }
}

/// An empty formula would show as nothing, and a very long one stays source text.
fn push_formula(math: &mut Vec<MathSpan>, range: Range<usize>, tex: &str, display: bool) {
    if !tex.trim().is_empty() && tex.len() <= MAX_FORMULA_BYTES {
        math.push(MathSpan {
            range,
            tex: tex.to_owned(),
            display,
        });
    }
}

fn link_of(link_type: LinkType, dest: &str, range: Range<usize>, embed: bool) -> Option<Link> {
    match link_type {
        LinkType::WikiLink { .. } => {
            // `[[Plan\|text]]` inside a table: the `\` escaped the pipe.
            let dest = dest.strip_suffix('\\').unwrap_or(dest);
            let (target, anchor) = split_anchor(dest);
            Some(Link {
                range,
                kind: LinkKind::Wiki,
                embed,
                target: target.trim().to_owned(),
                anchor,
            })
        }
        LinkType::Inline | LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
            if has_scheme(dest) {
                return None;
            }
            let (path, fragment) = match dest.split_once('#') {
                Some((path, fragment)) => (path, Some(fragment)),
                None => (dest, None),
            };
            let path = percent_decode(path)?;
            if !path.is_empty() && !is_note_name(&path) {
                return None;
            }
            if path.is_empty() && fragment.is_none() {
                return None;
            }
            Some(Link {
                range,
                kind: LinkKind::Markdown,
                embed,
                target: path,
                anchor: fragment
                    .filter(|fragment| !fragment.is_empty())
                    .and_then(percent_decode)
                    .map(Anchor::Heading),
            })
        }
        _ => None,
    }
}

pub(super) fn split_anchor(dest: &str) -> (&str, Option<Anchor>) {
    match dest.split_once('#') {
        Some((target, anchor)) => {
            let anchor = anchor.trim();
            let anchor = match anchor.strip_prefix('^') {
                Some(block) if !block.is_empty() => Some(Anchor::Block(block.to_owned())),
                _ if anchor.is_empty() => None,
                _ => Some(Anchor::Heading(anchor.to_owned())),
            };
            (target, anchor)
        }
        None => (dest, None),
    }
}

/// `http:`, `javascript:`, `C:` … — anything with a scheme is not a note path.
pub(super) fn has_scheme(dest: &str) -> bool {
    let Some((scheme, _)) = dest.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// `%20` and friends; `None` for broken escapes or bytes that are not UTF-8.
pub fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Front matter counts only at the very start: `---` on the first line up to the
/// next line that is `---` or `...`. Returns where the body starts.
fn front_matter_end(text: &str) -> usize {
    let mut lines = text.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return 0;
    };
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return 0;
    }
    let mut end = first.len();
    for line in lines {
        end += line.len();
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare == "---" || bare == "..." {
            return end;
        }
    }
    0
}

/// `%%…%%` outside code, paired in order; an unpaired `%%` runs to the end.
fn comments(text: &str, start: usize, code: &[Range<usize>]) -> Vec<Range<usize>> {
    let mut marks = Vec::new();
    let mut from = start;
    while let Some(found) = text[from..].find("%%") {
        let at = from + found;
        if !code.iter().any(|range| range.contains(&at)) {
            marks.push(at);
        }
        from = at + 2;
    }
    marks
        .chunks(2)
        .map(|pair| pair[0]..pair.get(1).map_or(text.len(), |end| end + 2))
        .collect()
}

/// Where a link leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Note {
        path: String,
    },
    /// More than one note fits; the user picks.
    Ambiguous {
        candidates: Vec<String>,
    },
    /// No note fits; following asks to create this one.
    Missing {
        path: String,
    },
    /// Outside the project, a protected or skipped place, a file that is no note.
    NotNote,
}

/// The project's notes, looked up without case.
#[derive(Debug, Default)]
pub struct NoteSet {
    paths: Vec<String>,
    /// File name without its ending → paths.
    by_name: HashMap<String, Vec<usize>>,
    /// Path without its ending → path.
    by_path: HashMap<String, usize>,
}

const ATTACHMENTS: [&str; 12] = [
    "png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "mp3", "mp4", "webm", "wav", "canvas",
];

impl NoteSet {
    pub fn new(paths: impl IntoIterator<Item = String>) -> Self {
        let mut set = Self::default();
        for path in paths {
            let index = set.paths.len();
            let bare = without_ending(&path).to_lowercase();
            let name = bare.rsplit('/').next().unwrap_or(&bare).to_owned();
            set.by_name.entry(name).or_default().push(index);
            set.by_path.insert(bare, index);
            set.paths.push(path);
        }
        set
    }

    /// Front matter aliases count like a second name (M3-007, owner decision).
    pub fn with_aliases(
        paths: impl IntoIterator<Item = String>,
        aliases: &[(String, String)],
    ) -> Self {
        let mut set = Self::new(paths);
        let index_of: HashMap<String, usize> = set
            .paths
            .iter()
            .enumerate()
            .map(|(index, path)| (path.to_lowercase(), index))
            .collect();
        for (path, alias) in aliases {
            if let Some(index) = index_of.get(&path.to_lowercase()) {
                let names = set.by_name.entry(alias.to_lowercase()).or_default();
                if !names.contains(index) {
                    names.push(*index);
                }
            }
        }
        set
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// The text Liurium writes inside `[[…]]` for a note: its name when that is
    /// unique, else the shortest end of its path that is (ADR-0020).
    pub fn link_text(&self, path: &str) -> String {
        let bare = without_ending(path);
        let parts: Vec<&str> = bare.split('/').collect();
        for take in 1..=parts.len() {
            let suffix = parts[parts.len() - take..].join("/");
            // A bare name must also be unique among aliases.
            let unique = if take == 1 {
                self.by_name
                    .get(&suffix.to_lowercase())
                    .is_some_and(|names| names.len() == 1)
            } else {
                self.ends_with(&suffix).len() == 1
            };
            if unique {
                return suffix;
            }
        }
        // A note at the top whose name another note shares: its full name with the
        // ending, which resolves from the project root first.
        path.to_owned()
    }

    fn ends_with(&self, suffix: &str) -> Vec<usize> {
        let suffix = suffix.to_lowercase();
        let tail = format!("/{suffix}");
        self.by_path
            .iter()
            .filter(|(bare, _)| **bare == suffix || bare.ends_with(&tail))
            .map(|(_, index)| *index)
            .collect()
    }

    fn found(&self, mut indexes: Vec<usize>, missing: impl FnOnce() -> Target) -> Target {
        indexes.sort_unstable();
        indexes.dedup();
        match indexes.as_slice() {
            [] => missing(),
            [one] => Target::Note {
                path: self.paths[*one].clone(),
            },
            many => {
                let mut candidates: Vec<String> = many
                    .iter()
                    .map(|index| self.paths[*index].clone())
                    .collect();
                candidates.sort_by_key(|path| path.to_lowercase());
                Target::Ambiguous { candidates }
            }
        }
    }
}

fn without_ending(path: &str) -> &str {
    let lower = path.to_lowercase();
    for ending in [".markdown", ".md"] {
        if lower.ends_with(ending) {
            return &path[..path.len() - ending.len()];
        }
    }
    path
}

pub(super) fn allowed(path: &RelPath) -> bool {
    path.parts().all(|part| {
        !part.starts_with('.') && !SKIPPED_FOLDERS.contains(&part.to_lowercase().as_str())
    })
}

/// Where `link`, written in the note at `source`, leads.
pub fn resolve(source: &RelPath, link: &Link, notes: &NoteSet) -> Target {
    if link.target.is_empty() {
        return Target::Note {
            path: source.to_string(),
        };
    }
    match link.kind {
        LinkKind::Wiki => resolve_wiki(source, link, notes),
        LinkKind::Markdown => resolve_markdown(source, link, notes),
    }
}

fn resolve_wiki(source: &RelPath, link: &Link, notes: &NoteSet) -> Target {
    let text = link.target.replace('\\', "/");
    let Ok(path) = RelPath::parse(&text) else {
        return Target::NotNote;
    };
    if !allowed(&path) {
        return Target::NotNote;
    }
    let written = path.to_string();
    let bare = without_ending(&written).to_lowercase();
    let with_md = |folder: Option<RelPath>| {
        let name = if is_note_name(&written) {
            path.file_name().to_owned()
        } else {
            format!("{}.md", path.file_name())
        };
        let created = match folder {
            Some(folder) => folder.child(&name),
            None => RelPath::name(&name),
        };
        created.map_or(Target::NotNote, |created| Target::Missing {
            path: created.to_string(),
        })
    };
    let attachment = path
        .file_name()
        .rsplit_once('.')
        .is_some_and(|(_, ext)| ATTACHMENTS.contains(&ext.to_lowercase().as_str()));
    if attachment || link.embed && !is_note_name(&written) && !notes.by_name.contains_key(&bare) {
        return Target::NotNote;
    }
    // A name with its ending, such as `[[Plan.md]]`, names that path from the root first.
    if is_note_name(&written)
        && let Some(index) = notes.by_path.get(&bare)
        && notes.paths[*index].to_lowercase() == written.to_lowercase()
    {
        return Target::Note {
            path: notes.paths[*index].clone(),
        };
    }
    if path.parent().is_some() {
        // A path: from the project root, else the end of exactly one path.
        if let Some(index) = notes.by_path.get(&bare) {
            return Target::Note {
                path: notes.paths[*index].clone(),
            };
        }
        return notes.found(notes.ends_with(&bare), || with_md(path.parent()));
    }
    let indexes = notes.by_name.get(&bare).cloned().unwrap_or_default();
    notes.found(indexes, || with_md(source.parent()))
}

fn resolve_markdown(source: &RelPath, link: &Link, notes: &NoteSet) -> Target {
    let joined = match source.parent() {
        Some(folder) => format!("{folder}/{}", link.target),
        None => link.target.clone(),
    };
    let Ok(path) = RelPath::parse(&joined) else {
        return Target::NotNote;
    };
    if !allowed(&path) || !is_note_name(path.file_name()) {
        return Target::NotNote;
    }
    let written = path.to_string();
    match notes.by_path.get(&without_ending(&written).to_lowercase()) {
        Some(index) if notes.paths[*index].to_lowercase() == written.to_lowercase() => {
            Target::Note {
                path: notes.paths[*index].clone(),
            }
        }
        _ => Target::Missing { path: written },
    }
}

/// Byte offsets to the editor's UTF-16 offsets; `offsets` must be char boundaries.
pub fn utf16_offsets(text: &str, offsets: &[usize]) -> Vec<usize> {
    let mut sorted: Vec<(usize, usize)> = offsets
        .iter()
        .copied()
        .enumerate()
        .map(|(i, o)| (o, i))
        .collect();
    sorted.sort_unstable();
    let mut result = vec![0; offsets.len()];
    let mut units = 0;
    let mut chars = text.char_indices().peekable();
    for (offset, index) in sorted {
        while let Some((at, c)) = chars.peek().copied() {
            if at >= offset {
                break;
            }
            units += c.len_utf16();
            chars.next();
        }
        result[index] = units;
    }
    result
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
