//! The links of the note in the editor (M3-005): every link in the page's text with
//! its place in the editor's units (UTF-16) and where it leads, so styling and
//! Ctrl + click follow Rust's parse. The text is only parsed, never written.

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{
    NoteFacts,
    backlinks::{backlinks as find_backlinks, project_tags as stored_tags, refresh_notes},
    links::{self, Anchor, Link, LinkKind, NoteSet, Target},
    session::{MAX_NOTE_BYTES, note_path},
};
use crate::storage::{db, fs::FsError};

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

/// The links and tags of the editor's text (M3-005, M3-007).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteMarks.ts"))]
pub struct NoteMarks {
    pub links: Vec<NoteLink>,
    /// `#tags` in the text, ranges in the editor's units.
    pub tags: Vec<NoteTag>,
    /// Tags from the front matter, without `#`.
    pub front_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteTag.ts"))]
pub struct NoteTag {
    pub from: usize,
    pub to: usize,
    /// Without `#`.
    pub tag: String,
}

pub fn note_links_in(source: &str, text: &str, set: &NoteSet) -> Result<NoteMarks, CommandError> {
    let source = note_path(source)?;
    let facts = NoteFacts::of(text);
    let found = &facts.links;
    let bounds: Vec<usize> = found
        .iter()
        .flat_map(|link| [link.range.start, link.range.end])
        .chain(
            facts
                .tags
                .iter()
                .flat_map(|tag| [tag.range.start, tag.range.end]),
        )
        .collect();
    let units = links::utf16_offsets(text, &bounds);
    let (link_units, tag_units) = units.split_at(found.len() * 2);
    let tags = facts
        .tags
        .iter()
        .zip(tag_units.chunks(2))
        .map(|(tag, range)| NoteTag {
            from: range[0],
            to: range[1],
            tag: tag.tag.clone(),
        })
        .collect();
    let links = found
        .iter()
        .zip(link_units.chunks(2))
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
        .collect();
    Ok(NoteMarks {
        links,
        tags,
        front_tags: facts.front.tags,
    })
}

/// A note that links to the open one (M3-006).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "BacklinkSource.ts"))]
pub struct BacklinkSource {
    pub path: String,
    pub links: Vec<BacklinkLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "BacklinkLine.ts"))]
pub struct BacklinkLine {
    /// Where the link starts in the source note's text, in UTF-16 units.
    pub offset: usize,
    /// The line around the link, shortened with "…" when long.
    pub line: String,
    /// The link inside `line`, in UTF-16 units.
    pub from: usize,
    pub to: usize,
}

impl Workspace {
    /// The notes that link to `path`, after the notes saved in Liurium since the
    /// last walk had their links read again.
    pub fn backlinks(&self, path: &str) -> Result<Vec<BacklinkSource>, CommandError> {
        let target = note_path(path)?;
        let set = self.note_set()?;
        let (id, root, _) = self.open_project_root()?.ok_or(CommandError::NoProject)?;
        let mut cache = db::open_cache(self.app_dir()?, &id)?;
        refresh_notes(&mut cache.connection, &root, &self.editor().take_saved())?;
        Ok(find_backlinks(&cache.connection, &root, &set, &target)?
            .into_iter()
            .map(|source| BacklinkSource {
                path: source.path,
                links: source
                    .links
                    .into_iter()
                    .map(|link| BacklinkLine {
                        offset: link.offset,
                        line: link.line,
                        from: link.from,
                        to: link.to,
                    })
                    .collect(),
            })
            .collect())
    }

    pub fn note_links(&self, path: &str, text: &str) -> Result<NoteMarks, CommandError> {
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
) -> Result<NoteMarks, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.note_links(&path, &text)).await
}

/// A tag and the notes that carry it (M3-007).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "TagNotes.ts"))]
pub struct TagNotes {
    /// As first written in the project; tags are compared without case.
    pub tag: String,
    pub notes: Vec<String>,
}

impl Workspace {
    /// Every tag of the open project with its notes, after the notes saved in
    /// Liurium had their facts read again.
    pub fn project_tags(&self) -> Result<Vec<TagNotes>, CommandError> {
        let (id, root, _) = self.open_project_root()?.ok_or(CommandError::NoProject)?;
        // Waits for the walk, so the cache holds every note.
        self.note_set()?;
        let mut cache = db::open_cache(self.app_dir()?, &id)?;
        refresh_notes(&mut cache.connection, &root, &self.editor().take_saved())?;
        Ok(stored_tags(&cache.connection)?
            .into_iter()
            .map(|(tag, notes)| TagNotes { tag, notes })
            .collect())
    }
}

#[tauri::command]
pub async fn project_tags(workspace: State<'_, Workspace>) -> Result<Vec<TagNotes>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.project_tags()).await
}

#[tauri::command]
pub async fn backlinks(
    path: String,
    workspace: State<'_, Workspace>,
) -> Result<Vec<BacklinkSource>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.backlinks(&path)).await
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

        let found = note_links_in("Ideas/Source.md", text, &set())
            .expect("links")
            .links;

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
