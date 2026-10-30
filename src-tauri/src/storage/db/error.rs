use std::{error::Error, fmt, io};

use rusqlite::ErrorCode;

/// Why a database could not be opened or migrated. Liurium never changes the file in
/// these cases, apart from SQLite rolling back a transaction that a crash left behind.
#[derive(Debug)]
pub enum DbError {
    /// The caller asked for an existing database and the file is not there.
    Missing,
    /// A SQLite file that Liurium did not create, or one made for the other kind.
    NotLiurium,
    /// Not a database, or the integrity check failed.
    Corrupt,
    /// Made by a newer Liurium that knows more migrations than this one.
    NewerSchema {
        found: u32,
        supported: u32,
    },
    /// Another process held a lock for longer than the busy timeout.
    Locked,
    /// The disk is full, or the database reached its size limit.
    DiskFull,
    /// SQLite kept another journal mode than the one this database needs.
    JournalMode {
        wanted: &'static str,
        got: String,
    },
    /// Migration `version` failed; all pending migrations were rolled back.
    Migration {
        version: u32,
        source: rusqlite::Error,
    },
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(f, "the database file does not exist"),
            Self::NotLiurium => write!(f, "the file is not a Liurium database of this kind"),
            Self::Corrupt => write!(f, "the database is damaged"),
            Self::NewerSchema { found, supported } => write!(
                f,
                "the database was made by a newer Liurium (schema {found}, this version knows {supported})"
            ),
            Self::Locked => write!(f, "another program is using the database"),
            Self::DiskFull => write!(f, "the disk is full"),
            Self::JournalMode { wanted, got } => {
                write!(f, "journal mode {got} instead of {wanted}")
            }
            Self::Migration { version, .. } => write!(f, "migration {version} failed"),
            Self::Io(error) => write!(f, "file error: {error}"),
            Self::Sqlite(error) => write!(f, "database error: {error}"),
        }
    }
}

impl Error for DbError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Migration { source, .. } => Some(source),
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for DbError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Self::Locked,
            Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => Self::Corrupt,
            Some(ErrorCode::DiskFull) => Self::DiskFull,
            _ => Self::Sqlite(error),
        }
    }
}
