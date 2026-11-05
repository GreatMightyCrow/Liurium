//! The properties box (M3-015). Editing is a pure text change: the page sends the
//! note's text and one edit and puts the answer into the editor, so it saves like
//! typing, with the same conflict check. Kinds live in the project's database.

use serde::Serialize;
use tauri::State;

use super::{CommandError, Workspace, projects::blocking};
use crate::domain::notes::{
    links::utf16_offsets,
    properties::{self, Edit, EditError, MAX_NAME_CHARS, Value, View},
    session::MAX_NOTE_BYTES,
};
use crate::domain::projects::PropertyKind;
use crate::storage::fs::FsError;

/// One property of the open note's front matter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "PropertyField.ts"))]
pub struct PropertyField {
    pub name: String,
    pub value: Value,
}

/// How the open note's front matter shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "NoteProperties.ts"))]
pub enum NoteProperties {
    /// The note has no block.
    None,
    /// A block the box cannot show safely; it stays in the text.
    AsText,
    Fields {
        /// The whole block, in the editor's units.
        from: usize,
        to: usize,
        fields: Vec<PropertyField>,
    },
}

impl NoteProperties {
    pub fn of(text: &str) -> Self {
        match properties::read(text) {
            View::None => Self::None,
            View::AsText => Self::AsText,
            View::Fields { range, fields } => {
                let units = utf16_offsets(text, &[range.start, range.end]);
                Self::Fields {
                    from: units[0],
                    to: units[1],
                    fields: fields
                        .into_iter()
                        .map(|field| PropertyField {
                            name: field.name,
                            value: field.value,
                        })
                        .collect(),
                }
            }
        }
    }
}

/// A kind chosen for a property name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "PropertyKindChoice.ts"))]
pub struct PropertyKindChoice {
    pub name: String,
    pub kind: PropertyKind,
}

impl From<EditError> for CommandError {
    fn from(error: EditError) -> Self {
        match error {
            EditError::InvalidName => Self::InvalidName,
            EditError::NameTaken => Self::AlreadyExists,
            EditError::InvalidTag => Self::InvalidTag,
            EditError::Refused => Self::PropertyRefused,
        }
    }
}

/// The new text after one edit; nothing is written here.
pub fn edit_property_in(text: &str, edit: &Edit) -> Result<String, CommandError> {
    let limit = usize::try_from(MAX_NOTE_BYTES.saturating_mul(2)).unwrap_or(usize::MAX);
    if text.len() > limit {
        return Err(FsError::TooLarge {
            len: u64::try_from(text.len()).unwrap_or(u64::MAX),
            max: MAX_NOTE_BYTES,
        }
        .into());
    }
    Ok(properties::edit(text, edit)?)
}

#[tauri::command]
pub async fn edit_property(text: String, edit: Edit) -> Result<String, CommandError> {
    blocking(move || edit_property_in(&text, &edit)).await
}

#[tauri::command]
pub async fn property_kinds(
    workspace: State<'_, Workspace>,
) -> Result<Vec<PropertyKindChoice>, CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.property_kinds()).await
}

#[tauri::command]
pub async fn set_property_kind(
    name: String,
    kind: Option<PropertyKind>,
    workspace: State<'_, Workspace>,
) -> Result<(), CommandError> {
    let workspace = workspace.inner().clone();
    blocking(move || workspace.set_property_kind(&name, kind)).await
}

impl Workspace {
    pub fn property_kinds(&self) -> Result<Vec<PropertyKindChoice>, CommandError> {
        self.with_open_project(|project| {
            Ok(project
                .property_kinds()?
                .into_iter()
                .map(|(name, kind)| PropertyKindChoice { name, kind })
                .collect())
        })
    }

    pub fn set_property_kind(
        &self,
        name: &str,
        kind: Option<PropertyKind>,
    ) -> Result<(), CommandError> {
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(CommandError::InvalidName);
        }
        self.with_open_project(|project| {
            if project.read_only {
                return Err(CommandError::ReadOnly);
            }
            Ok(project.set_property_kind(name, kind)?)
        })
    }
}
