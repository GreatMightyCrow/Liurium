//! The links of the note in the editor (M3-005): every link in the page's text with
//! its place in the editor's units (UTF-16) and where it leads, so styling and
//! Ctrl + click follow Rust's parse. The text is only parsed, never written.

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{
    links::{self, Anchor, Link, LinkKind, NoteSet, Target},
    session::{MAX_NOTE_BYTES, note_path},
};
use crate::storage::fs::FsError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteLink.ts"))]
pub struct NoteLink {
    /// Start and end in the editor's units (UTF-16).
    pub from: usize,
    pub to: usize,
    pub target: LinkTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "LinkTarget.ts"))]
pub enum LinkTarget {
    Note {
        path: String,
        heading: Option<String>,
        block: Option<String>,
    },
    /// The user picks; the chosen one's `replacement` takes the link's place.
    Ambiguous { candidates: Vec<LinkCandidate> },
    /// Following asks to create this note.
    Missing { path: String },
    /// Not a note link; never followed.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "LinkCandidate.ts"))]
pub struct LinkCandidate {
    pub path: String,
    /// The whole link written with this note's path, text and heading kept.
    pub replacement: String,
}

/// `[[Plan#Top|text]]` with another target, keeping embed, anchor, and text.
fn rewritten(original: &str, link: &Link, target: &str) -> String {
    let alias = original
        .trim_end_matches("]]")
        .split_once('|')
        .map(|(_, alias)| alias);
    let anchor = match &link.anchor {
        Some(Anchor::Heading(heading)) => format!("#{heading}"),
        Some(Anchor::Block(block)) => format!("#^{block}"),
        None => String::new(),
    };
    let embed = if link.embed { "!" } else { "" };
    match alias {
        Some(alias) => format!("{embed}[[{target}{anchor}|{alias}]]"),
        None => format!("{embed}[[{target}{anchor}]]"),
    }
}

pub fn note_links_in(
    source: &str,
    text: &str,
    set: &NoteSet,
) -> Result<Vec<NoteLink>, CommandError> {
    let source = note_path(source)?;
    let found = links::parse(text);
    let bounds: Vec<usize> = found
        .iter()
        .flat_map(|link| [link.range.start, link.range.end])
        .collect();
    let units = links::utf16_offsets(text, &bounds);
    Ok(found
        .iter()
        .zip(units.chunks(2))
        .map(|(link, range)| {
            let target = match links::resolve(&source, link, set) {
                Target::Note { path } => {
                    let (heading, block) = match &link.anchor {
                        Some(Anchor::Heading(heading)) => (Some(heading.clone()), None),
                        Some(Anchor::Block(block)) => (None, Some(block.clone())),
                        None => (None, None),
                    };
                    LinkTarget::Note {
                        path,
                        heading,
                        block,
                    }
                }
                Target::Ambiguous { candidates } if link.kind == LinkKind::Wiki => {
                    let original = &text[link.range.clone()];
                    LinkTarget::Ambiguous {
                        candidates: candidates
                            .into_iter()
                            .map(|path| LinkCandidate {
                                replacement: rewritten(original, link, &set.link_text(&path)),
                                path,
                            })
                            .collect(),
                    }
                }
                Target::Missing { path } if !link.embed => LinkTarget::Missing { path },
                _ => LinkTarget::Other,
            };
            NoteLink {
                from: range[0],
                to: range[1],
                target,
            }
        })
        .collect())
}

impl Workspace {
    pub fn note_links(&self, path: &str, text: &str) -> Result<Vec<NoteLink>, CommandError> {
        let limit = usize::try_from(MAX_NOTE_BYTES.saturating_mul(2)).unwrap_or(usize::MAX);
        if text.len() > limit {
            return Err(FsError::TooLarge {
                len: u64::try_from(text.len()).unwrap_or(u64::MAX),
                max: MAX_NOTE_BYTES,
            }
            .into());
        }
        let set = self.note_set()?;
        note_links_in(path, text, &set)
    }
}

#[tauri::command]
pub async fn note_links(
    path: String,
    text: String,
    workspace: State<'_, Workspace>,
) -> Result<Vec<NoteLink>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.note_links(&path, &text)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set() -> NoteSet {
        NoteSet::new(["Plan.md", "Ideas/Plan.md", "Unique.md"].map(String::from))
    }

    #[test]
    fn links_come_with_utf16_ranges_and_their_targets() {
        let text = "ä 😀 [[Unique#Top]] [[Plan|mine]] [[New idea]] ![[x.png]]";

        let found = note_links_in("Ideas/Source.md", text, &set()).expect("links");

        let unique = text.encode_utf16().collect::<Vec<_>>();
        let slice = |link: &NoteLink| String::from_utf16_lossy(&unique[link.from..link.to]);
        assert_eq!(slice(&found[0]), "[[Unique#Top]]");
        assert_eq!(
            found[0].target,
            LinkTarget::Note {
                path: "Unique.md".into(),
                heading: Some("Top".into()),
                block: None
            }
        );
        assert_eq!(
            found[1].target,
            LinkTarget::Ambiguous {
                candidates: vec![
                    LinkCandidate {
                        path: "Ideas/Plan.md".into(),
                        replacement: "[[Ideas/Plan|mine]]".into()
                    },
                    LinkCandidate {
                        path: "Plan.md".into(),
                        replacement: "[[Plan.md|mine]]".into()
                    },
                ]
            }
        );
        assert_eq!(
            found[2].target,
            LinkTarget::Missing {
                path: "Ideas/New idea.md".into()
            }
        );
        assert_eq!(found[3].target, LinkTarget::Other);
    }

    #[test]
    fn the_source_must_be_a_note_path() {
        assert_eq!(
            note_links_in(".liurium/x.md", "[[a]]", &set()).unwrap_err(),
            CommandError::InvalidPath
        );
    }

    #[test]
    fn rewriting_keeps_embed_anchor_and_text() {
        let text = "![[Plan#^b1|shown]]";
        let link = links::parse(text).remove(0);
        assert_eq!(
            rewritten(text, &link, "Ideas/Plan"),
            "![[Ideas/Plan#^b1|shown]]"
        );
    }
}
