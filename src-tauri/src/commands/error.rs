use serde::Serialize;

use crate::domain::projects::ProjectError;
use crate::storage::{db::DbError, fs::FsError};

/// What a command reports to the page: a kind the UI can explain in plain words.
/// Never paths, file contents, or operating-system messages; details stay in Rust
/// for the log (M6-004).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CommandError.ts"))]
pub enum CommandError {
    NotFound,
    AlreadyExists,
    /// Changed or deleted outside Liurium since it was read.
    Changed,
    ReadOnly,
    /// Another program holds the data.
    Locked,
    DiskFull,
    /// Damaged, or not made by Liurium.
    Damaged,
    /// Made by a newer Liurium.
    NewerVersion,
    /// Updating the data to this version failed; nothing was changed.
    UpgradeFailed,
    InvalidPath,
    /// Leads outside the project, also through a link.
    OutsideProject,
    /// Inside `.liurium` or `.git`.
    Protected,
    BrokenLink,
    /// A folder where a file was expected, or the other way round.
    WrongKind,
    TooLarge {
        #[cfg_attr(test, ts(type = "number"))]
        max_bytes: u64,
    },
    /// A whole drive, or a folder inside `.liurium` or `.git`.
    UnsuitableFolder,
    /// The project's folder now holds a different project.
    OtherProject,
    /// Another folder holds the same project; it was copied.
    DuplicateProject,
    /// The chosen folder holds no Liurium project.
    NoProject,
    /// A name that is empty, too long, or has control characters.
    InvalidName,
    /// The file is not UTF-8 text (M3-003).
    NotUtf8,
    /// The note has changes that are not saved yet.
    Unsaved,
    /// Nothing the user can act on.
    Internal,
}

// Every variant is named, so a new storage error needs a decision here.
impl From<DbError> for CommandError {
    fn from(error: DbError) -> Self {
        match error {
            DbError::Missing => Self::NotFound,
            DbError::NotLiurium | DbError::Corrupt => Self::Damaged,
            DbError::NewerSchema { .. } => Self::NewerVersion,
            DbError::Locked => Self::Locked,
            DbError::DiskFull => Self::DiskFull,
            DbError::ReadOnly => Self::ReadOnly,
            DbError::Migration { .. } => Self::UpgradeFailed,
            DbError::JournalMode { .. } | DbError::Io(_) | DbError::Sqlite(_) => Self::Internal,
        }
    }
}

impl From<FsError> for CommandError {
    fn from(error: FsError) -> Self {
        match error {
            FsError::InvalidPath(_) => Self::InvalidPath,
            FsError::OutsideRoot => Self::OutsideProject,
            FsError::Protected => Self::Protected,
            FsError::BrokenLink => Self::BrokenLink,
            FsError::NotFound => Self::NotFound,
            FsError::WrongKind => Self::WrongKind,
            FsError::AlreadyExists => Self::AlreadyExists,
            FsError::Changed => Self::Changed,
            FsError::ReadOnly => Self::ReadOnly,
            FsError::TooLarge { max, .. } => Self::TooLarge { max_bytes: max },
            FsError::Io(_) => Self::Internal,
        }
    }
}

impl From<ProjectError> for CommandError {
    fn from(error: ProjectError) -> Self {
        match error {
            ProjectError::Fs(error) => error.into(),
            ProjectError::Db(error) => error.into(),
            ProjectError::Unsuitable => Self::UnsuitableFolder,
            ProjectError::Damaged => Self::Damaged,
            ProjectError::Unknown => Self::NotFound,
            ProjectError::OtherProject => Self::OtherProject,
            ProjectError::Duplicate(_) => Self::DuplicateProject,
            ProjectError::Changed => Self::Changed,
            ProjectError::NoProject => Self::NoProject,
            ProjectError::InvalidName => Self::InvalidName,
        }
    }
}
