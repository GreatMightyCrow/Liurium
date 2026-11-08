use serde::Serialize;

use crate::domain::projects::{ProjectError, tasks::TaskError};
use crate::storage::{
    db::DbError,
    fs::{FsError, PathRule},
};

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
    /// A link or junction, which Liurium does not rename, move, or delete (M3-004).
    IsLink,
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
    /// A name Liurium skips in the notes tree (starting with `.`, or a package folder
    /// such as `node_modules`), so the item would not show up (M3-004).
    SkippedName,
    /// The file is not UTF-8 text (M3-003).
    NotUtf8,
    /// The note has changes that are not saved yet.
    Unsaved,
    /// A tag with characters a tag cannot have (M3-015).
    InvalidTag,
    /// A property change that could harm the rest of the front matter (M3-015).
    PropertyRefused,
    /// An address Liurium does not open (M3-012).
    LinkRefused,
    /// Windows could not open the address (M3-012).
    LinkNotOpened,
    /// A task's title, text, or date outside the rules (M4-003).
    InvalidTask,
    /// Too many tasks, columns, tags, or note links (M4-003).
    TaskLimit,
    /// The column still holds tasks, or is the last one (M4-003).
    ColumnInUse,
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
            FsError::InvalidPath(PathRule::Skipped) => Self::SkippedName,
            FsError::InvalidPath(_) => Self::InvalidPath,
            FsError::OutsideRoot => Self::OutsideProject,
            FsError::Protected => Self::Protected,
            FsError::BrokenLink => Self::BrokenLink,
            FsError::IsLink => Self::IsLink,
            FsError::IntoItself => Self::InvalidPath,
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

impl From<TaskError> for CommandError {
    fn from(error: TaskError) -> Self {
        match error {
            TaskError::Project(error) => error.into(),
            TaskError::NotFound => Self::NotFound,
            TaskError::Invalid => Self::InvalidTask,
            TaskError::InvalidColumnName => Self::InvalidName,
            TaskError::InvalidTag => Self::InvalidTag,
            TaskError::Limit => Self::TaskLimit,
            TaskError::ColumnInUse => Self::ColumnInUse,
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
