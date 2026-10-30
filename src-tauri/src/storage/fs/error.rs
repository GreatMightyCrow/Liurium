use std::{error::Error, fmt, io};

use super::PathRule;

/// Why a file operation was refused or failed. A refused write leaves the target
/// file as it was.
#[derive(Debug)]
pub enum FsError {
    /// The text is not an acceptable path below a project.
    InvalidPath(PathRule),
    /// After following links, the path leads outside the project.
    OutsideRoot,
    /// `.liurium` and `.git` are written only by their own modules.
    Protected,
    /// A link whose target does not exist.
    BrokenLink,
    NotFound,
    /// A folder where a file was expected, or the other way round.
    WrongKind,
    AlreadyExists,
    /// The file changed on disk since Liurium last read it, or was deleted.
    Changed,
    ReadOnly,
    TooLarge {
        len: u64,
        max: u64,
    },
    Io(io::Error),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(rule) => write!(f, "the path is not allowed ({rule:?})"),
            Self::OutsideRoot => write!(f, "the path leads outside the project"),
            Self::Protected => write!(f, "this folder is managed by Liurium or Git"),
            Self::BrokenLink => write!(f, "the link points to nothing"),
            Self::NotFound => write!(f, "the file does not exist"),
            Self::WrongKind => write!(f, "a file and a folder were mixed up"),
            Self::AlreadyExists => write!(f, "the file already exists"),
            Self::Changed => write!(f, "the file was changed outside Liurium"),
            Self::ReadOnly => write!(f, "the file is read-only"),
            Self::TooLarge { len, max } => {
                write!(f, "the file is too large ({len} bytes, at most {max})")
            }
            Self::Io(error) => write!(f, "file error: {error}"),
        }
    }
}

impl Error for FsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for FsError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            _ => Self::Io(error),
        }
    }
}
