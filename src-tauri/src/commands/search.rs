//! Search (M4-001): the open project's notes in full text, and every known project by
//! its name. Read only; the query is untrusted and only ever used as text.

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::{
    notes::{
        backlinks::refresh_notes,
        search::{self, MIN_TEXT_WORD},
    },
    projects,
};
use crate::storage::db;

/// At most this many projects come back.
const MAX_PROJECTS: usize = 20;

/// The line of a note's first match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SearchExcerpt.ts"))]
pub struct SearchExcerpt {
    /// Where the match starts in the note's text, in UTF-16 units.
    pub offset: usize,
    /// The line around the match, shortened with "…" when long.
    pub line: String,
    /// The match inside `line`, in UTF-16 units.
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteHit.ts"))]
pub struct NoteHit {
    pub path: String,
    /// `None` when only the name, an alias, or a property matched.
    pub excerpt: Option<SearchExcerpt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ProjectHit.ts"))]
pub struct ProjectHit {
    pub id: String,
    pub name: String,
    /// The project open now.
    pub open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SearchResults.ts"))]
pub struct SearchResults {
    /// Notes of the open project, best first; empty without an open project.
    pub notes: Vec<NoteHit>,
    /// Known projects whose name holds every word.
    pub projects: Vec<ProjectHit>,
    /// Some word is shorter than three characters, so it only searched names.
    pub short_words: bool,
}

impl Workspace {
    pub fn search(&self, query: &str) -> Result<SearchResults, CommandError> {
        let words = search::words(query);
        let open = self.open_project_root()?;
        let open_id = open.as_ref().map(|(id, _, _)| id.clone());
        let projects = {
            let app = self.app()?;
            projects::names(&app)?
        }
        .into_iter()
        .filter(|(_, name)| !words.is_empty() && search::holds_all(name, &words))
        .take(MAX_PROJECTS)
        .map(|(id, name)| ProjectHit {
            open: open_id.as_deref() == Some(id.as_str()),
            id,
            name,
        })
        .collect();
        let notes = match open {
            Some((id, root, _)) if !words.is_empty() => {
                // Waits for the walk after opening, so the index is complete.
                self.note_set()?;
                let mut cache = db::open_cache(self.app_dir()?, &id)?;
                refresh_notes(&mut cache.connection, &root, &self.editor().take_saved())?;
                search::search(&cache.connection, &root, query)?
                    .into_iter()
                    .map(|hit| NoteHit {
                        path: hit.path,
                        excerpt: hit.excerpt.map(|excerpt| SearchExcerpt {
                            offset: excerpt.offset,
                            line: excerpt.line,
                            from: excerpt.from,
                            to: excerpt.to,
                        }),
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        Ok(SearchResults {
            notes,
            projects,
            short_words: words
                .iter()
                .any(|word| word.chars().count() < MIN_TEXT_WORD),
        })
    }
}

#[tauri::command]
pub async fn search_notes(
    query: String,
    workspace: State<'_, Workspace>,
) -> Result<SearchResults, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.search(&query)).await
}
