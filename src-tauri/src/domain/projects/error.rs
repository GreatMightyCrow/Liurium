use std::{error::Error, fmt};

use super::ProjectCopy;
use crate::storage::{db::DbError, fs::FsError};

/// Why a project could not be added, opened, renamed, removed, or located. The folder is left as it was; only
/// what this call created is removed again.
#[derive(Debug)]
pub enum ProjectError {
    Fs(FsError),
    Db(DbError),
    /// A whole drive, or a folder inside `.liurium` or `.git`.
    Unsuitable,
    /// `.liurium` has no valid project identity.
    Damaged,
    /// The registry knows no project with this id.
    Unknown,
    /// The registered folder now holds a different project.
    OtherProject,
    /// Another folder still holds this project: the folder was copied (ADR-0016). Nothing
    /// was written; the copy can be given its own identity (M2-011).
    Duplicate(Box<ProjectCopy>),
    /// The folder changed between a question and the answer (M2-011).
    Changed,
    /// The chosen folder holds no project (locating a moved project).
    NoProject,
    /// Empty, too long, or with control characters.
    InvalidName,
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fs(error) => write!(f, "{error}"),
            Self::Db(error) => write!(f, "{error}"),
            Self::Unsuitable => write!(f, "the folder cannot hold a project"),
            Self::Damaged => write!(f, "the project has no valid identity"),
            Self::Unknown => write!(f, "no project with this id"),
            Self::OtherProject => write!(f, "the folder holds another project"),
            Self::Duplicate(_) => write!(f, "another folder holds the same project"),
            Self::Changed => write!(f, "the folder changed in the meantime"),
            Self::NoProject => write!(f, "the folder holds no project"),
            Self::InvalidName => {
                write!(f, "the name is empty, too long, or has control characters")
            }
        }
    }
}

impl Error for ProjectError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Fs(error) => Some(error),
            Self::Db(error) => Some(error),
            _ => None,
        }
    }
}

impl From<FsError> for ProjectError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<DbError> for ProjectError {
    fn from(error: DbError) -> Self {
        Self::Db(error)
    }
}

impl From<rusqlite::Error> for ProjectError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error.into())
    }
}

impl From<std::io::Error> for ProjectError {
    fn from(error: std::io::Error) -> Self {
        Self::Fs(error.into())
    }
}
