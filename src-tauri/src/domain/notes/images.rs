//! Images in notes (M3-013, ADR-0020). A note's text names images; the walk says which
//! exist. Text is untrusted: looking one up touches only the walk's list, never the
//! disk, and the page gets an address only for a path on that list.

use std::{collections::HashMap, ops::Range};

use pulldown_cmark::LinkType;

use super::{
    external::checked_address,
    links::{allowed, has_scheme, percent_decode, split_anchor},
    nanos,
};
use crate::storage::fs::{FoundImage, RelPath, Stamp, is_image_name};

/// Windows shows a custom protocol at `http://<scheme>.localhost` (tauri 2.12.4).
const ORIGIN: &str = "http://liurium-image.localhost";

/// A width or height above this is no size but part of the text.
const MAX_SIDE: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageTarget {
    /// `![[pic.png]]`: by name anywhere in the project, or by path.
    Wiki(String),
    /// `![alt](pic.png)`: from the note's folder, then from the project's root.
    Relative(String),
    /// Checked and normalized; never fetched.
    Remote(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageLink {
    /// Bytes of the whole image in the note's text.
    pub range: Range<usize>,
    pub target: ImageTarget,
    pub alt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// An image the note's text names, if its form and name make one. Anything else stays
/// source text, as `data:` and `file:` addresses do.
pub(super) fn image_of(link_type: LinkType, dest: &str, range: Range<usize>) -> Option<ImageLink> {
    let target = match link_type {
        LinkType::WikiLink { .. } => {
            // `![[pic.png\|200]]` inside a table: the `\` escaped the pipe.
            let dest = dest.strip_suffix('\\').unwrap_or(dest);
            let name = split_anchor(dest).0.trim();
            named(name, ImageTarget::Wiki)?
        }
        LinkType::Inline | LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
            if has_scheme(dest) {
                let address = checked_address(dest)?;
                if address.starts_with("mailto:") {
                    return None;
                }
                ImageTarget::Remote(address)
            } else {
                let path = percent_decode(dest.split(['#', '?']).next().unwrap_or(dest))?;
                named(&path, ImageTarget::Relative)?
            }
        }
        _ => return None,
    };
    let alt = default_alt(&target);
    Some(ImageLink {
        range,
        target,
        alt,
        width: None,
        height: None,
    })
}

/// The target for a file name, by its ending; `None` for a file that is no image.
fn named(name: &str, target: fn(String) -> ImageTarget) -> Option<ImageTarget> {
    is_image_name(name).then(|| target(name.to_owned()))
}

fn default_alt(target: &ImageTarget) -> String {
    match target {
        ImageTarget::Wiki(path) | ImageTarget::Relative(path) => {
            path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
        }
        ImageTarget::Remote(address) => address.clone(),
    }
}

/// `200` or `200x100`.
fn size_of(text: &str) -> Option<(u32, Option<u32>)> {
    let side = |digits: &str| {
        (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
            .then(|| digits.parse::<u32>().ok())
            .flatten()
            .filter(|side| (1..=MAX_SIDE).contains(side))
    };
    match text.trim().split_once('x') {
        Some((width, height)) => Some((side(width)?, Some(side(height)?))),
        None => Some((side(text.trim())?, None)),
    }
}

impl ImageLink {
    /// Reads what stands inside the image: alt text and a size, as in Obsidian:
    /// `![[pic.png|200]]`, `![[pic.png|Cat|200x100]]`, `![Cat|200](pic.png)`.
    pub(super) fn set_text(&mut self, written: &str) {
        let wiki = matches!(self.target, ImageTarget::Wiki(_));
        let (text, size) = match written.rsplit_once('|') {
            Some((text, end)) => match size_of(end) {
                Some(size) => (text, Some(size)),
                None => (written, None),
            },
            // A wikilink's only text may be its size; `![200](pic.png)` is alt text.
            None if wiki => match size_of(written) {
                Some(size) => ("", Some(size)),
                None => (written, None),
            },
            None => (written, None),
        };
        if let Some((width, height)) = size {
            self.width = Some(width);
            self.height = height;
        }
        // A wikilink with no text of its own gets its target as text from the parser.
        let text = text.trim();
        let only_its_target = matches!(&self.target, ImageTarget::Wiki(name) if name == text);
        if !text.is_empty() && !only_its_target {
            text.clone_into(&mut self.alt);
        }
    }
}

/// An image the walk found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownImage {
    pub path: String,
    pub stamp: Stamp,
}

impl KnownImage {
    /// Where the page loads it from. The project is in it, so an address from another
    /// project fails; the stamp too, so a changed image is a new address.
    pub fn address(&self, project: &str) -> String {
        let path = self
            .path
            .split('/')
            .map(encoded)
            .collect::<Vec<_>>()
            .join("/");
        format!(
            "{ORIGIN}/{}/{path}?v={}-{}",
            encoded(project),
            nanos(self.stamp.modified),
            self.stamp.len
        )
    }
}

fn encoded(text: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            write!(out, "%{byte:02X}").ok();
        }
    }
    out
}

/// Where an image in a note leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedImage {
    Found(KnownImage),
    Ambiguous(Vec<String>),
    Missing(String),
    Refused,
}

/// The images of one walk, looked up without case.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageSet {
    images: Vec<KnownImage>,
    /// File name → images.
    by_name: HashMap<String, Vec<usize>>,
    /// Path → image.
    by_path: HashMap<String, usize>,
}

impl ImageSet {
    pub fn new(found: Vec<FoundImage>) -> Self {
        let mut set = Self::default();
        for image in found {
            let index = set.images.len();
            let path = image.path.to_string();
            let lower = path.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_owned();
            set.by_name.entry(name).or_default().push(index);
            set.by_path.insert(lower, index);
            set.images.push(KnownImage {
                path,
                stamp: image.stamp,
            });
        }
        set
    }

    /// The image the walk listed at exactly this path, without case.
    pub fn listed(&self, path: &str) -> Option<&KnownImage> {
        self.by_path
            .get(&path.to_lowercase())
            .map(|index| &self.images[*index])
    }

    pub fn resolve(&self, source: &RelPath, image: &ImageLink) -> ResolvedImage {
        match &image.target {
            ImageTarget::Wiki(target) => self.resolve_wiki(target),
            ImageTarget::Relative(target) => self.resolve_relative(source, target),
            // The caller does not look these up.
            ImageTarget::Remote(_) => ResolvedImage::Refused,
        }
    }

    fn resolve_wiki(&self, target: &str) -> ResolvedImage {
        let Some(path) = safe_path(target) else {
            return ResolvedImage::Refused;
        };
        let written = path.to_string();
        let lower = written.to_lowercase();
        if let Some(found) = self.listed(&lower) {
            return ResolvedImage::Found(found.clone());
        }
        let indexes: Vec<usize> = if path.parent().is_some() {
            let tail = format!("/{lower}");
            self.by_path
                .iter()
                .filter(|(known, _)| known.ends_with(&tail))
                .map(|(_, index)| *index)
                .collect()
        } else {
            self.by_name.get(&lower).cloned().unwrap_or_default()
        };
        match indexes.as_slice() {
            [] => ResolvedImage::Missing(written),
            [one] => ResolvedImage::Found(self.images[*one].clone()),
            many => {
                let mut candidates: Vec<String> = many
                    .iter()
                    .map(|index| self.images[*index].path.clone())
                    .collect();
                candidates.sort_by_key(|path| path.to_lowercase());
                ResolvedImage::Ambiguous(candidates)
            }
        }
    }

    fn resolve_relative(&self, source: &RelPath, target: &str) -> ResolvedImage {
        // Joined to the note's folder, `/x.png` would quietly become a path inside it.
        if target.starts_with(['/', '\\']) {
            return ResolvedImage::Refused;
        }
        let beside = match source.parent() {
            Some(folder) => format!("{folder}/{target}"),
            None => target.to_owned(),
        };
        let Some(path) = safe_path(&beside) else {
            return ResolvedImage::Refused;
        };
        if let Some(found) = self.listed(&path.to_string()) {
            return ResolvedImage::Found(found.clone());
        }
        // Not beside the note: from the project's root, if that path stays inside too.
        if let Some(found) = safe_path(target).and_then(|path| self.listed(&path.to_string())) {
            return ResolvedImage::Found(found.clone());
        }
        ResolvedImage::Missing(target.to_owned())
    }
}

/// A path that stays inside the project, outside hidden and skipped folders.
fn safe_path(text: &str) -> Option<RelPath> {
    RelPath::parse(&text.replace('\\', "/"))
        .ok()
        .filter(allowed)
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
