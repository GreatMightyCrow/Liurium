//! Backup copies of `app.db` in the app data folder's `backups` folder (M3-009): how
//! many there are, and deleting the older ones. Only names Liurium makes count
//! (`migrate::backup_path`): `app-v<N>-<UTC>.db` before a migration and
//! `app-broken-<UTC>.db` for a damaged database moved aside, each with an optional
//! `-<n>` and SQLite's side files. Anything else in the folder, and every link or
//! folder, is left alone. Project backups live in project folders and are never
//! touched here.

use std::{collections::BTreeMap, fs, io, path::Path};

use super::{BACKUP_DIR, DbError};

/// SQLite's side files belong to the copy they sit next to.
const SIDE_FILES: [&str; 3] = ["-wal", "-shm", "-journal"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BackupSummary {
    /// Backup copies, each counted once with its side files.
    pub copies: usize,
    /// Size of all their files together.
    pub bytes: u64,
}

/// Newest first: later time, then the higher `-<n>` of the same second.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Age {
    stamp: String,
    count: u32,
    /// Keeps two copies of the same second apart (`v1` and `broken`).
    name: String,
}

#[derive(Debug, Default)]
struct Copy {
    files: Vec<std::path::PathBuf>,
    bytes: u64,
}

/// The copies in `<app_dir>/backups`; none when the folder does not exist.
pub fn summary(app_dir: &Path) -> Result<BackupSummary, DbError> {
    let copies = copies(app_dir)?;
    Ok(BackupSummary {
        copies: copies.len(),
        bytes: copies.values().map(|copy| copy.bytes).sum(),
    })
}

/// Deletes every copy but the newest `keep`, with its side files. Returns how many
/// copies were deleted. Stops at the first file that cannot be deleted.
pub fn prune(app_dir: &Path, keep: usize) -> Result<usize, DbError> {
    let copies = copies(app_dir)?;
    let old: Vec<&Copy> = copies.values().rev().skip(keep).collect();
    for copy in &old {
        for file in &copy.files {
            fs::remove_file(file)?;
        }
    }
    Ok(old.len())
}

/// Oldest first.
fn copies(app_dir: &Path) -> Result<BTreeMap<Age, Copy>, DbError> {
    let dir = app_dir.join(BACKUP_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    let mut copies: BTreeMap<Age, Copy> = BTreeMap::new();
    for entry in entries {
        let entry = entry?;
        // `symlink_metadata` does not follow links: a link is never a regular file.
        let meta = fs::symlink_metadata(entry.path())?;
        if !meta.file_type().is_file() {
            continue;
        }
        let Some(age) = entry.file_name().to_str().and_then(age_of) else {
            continue;
        };
        let copy = copies.entry(age).or_default();
        copy.files.push(entry.path());
        copy.bytes += meta.len();
    }
    // Side files whose copy is gone still count as a copy of their own, so they can be
    // cleaned up too.
    Ok(copies)
}

/// The age of a backup file, or `None` for a name Liurium does not make.
fn age_of(name: &str) -> Option<Age> {
    let base = SIDE_FILES
        .iter()
        .find_map(|side| name.strip_suffix(side))
        .unwrap_or(name);
    let rest = base.strip_prefix("app-")?.strip_suffix(".db")?;
    let (label, rest) = rest.split_once('-')?;
    let version = label.strip_prefix('v');
    let label_ok =
        label == "broken" || version.is_some_and(|digits| !digits.is_empty() && all_digits(digits));
    if !label_ok {
        return None;
    }
    let stamp = rest.get(..16).filter(|stamp| stamp.is_ascii())?;
    let bytes = stamp.as_bytes();
    let stamp_ok = all_digits(&stamp[..8])
        && bytes[8] == b'T'
        && all_digits(&stamp[9..15])
        && bytes[15] == b'Z';
    if !stamp_ok {
        return None;
    }
    let count = match &rest[16..] {
        "" => 1,
        tail => {
            let digits = tail.strip_prefix('-')?;
            if digits.is_empty() || !all_digits(digits) {
                return None;
            }
            digits.parse().ok()?
        }
    };
    Some(Age {
        stamp: stamp.to_owned(),
        count,
        name: base.to_owned(),
    })
}

fn all_digits(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::storage::db::migrate::backup_path;
    use crate::test_support::{junction, temp_dir};

    fn backups(dir: &Path) -> PathBuf {
        let backups = dir.join(BACKUP_DIR);
        fs::create_dir_all(&backups).expect("backups folder");
        backups
    }

    fn write(dir: &Path, name: &str, bytes: usize) {
        fs::write(dir.join(name), vec![0_u8; bytes]).expect("file");
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("folder")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn liurium_names_are_recognized_and_others_are_not() {
        for name in [
            "app-v1-20261030T101500Z.db",
            "app-v12-20261030T101500Z-3.db",
            "app-broken-20261030T101500Z.db",
            "app-broken-20261030T101500Z.db-wal",
            "app-broken-20261030T101500Z-2.db-journal",
            "app-v1-20261030T101500Z.db-shm",
        ] {
            assert!(age_of(name).is_some(), "{name} is a backup");
        }
        for name in [
            "app.db",
            "app-v1.db",
            "app-v-20261030T101500Z.db",
            "app-vx-20261030T101500Z.db",
            "app-old-20261030T101500Z.db",
            "app-v1-2026-10-30.db",
            "app-v1-20261030X101500Z.db",
            "app-v1-20261030T101500Z-.db",
            "app-v1-20261030T101500Z-a.db",
            "app-v1-20261030T101500Z.db.bak",
            "project-v1-20261030T101500Z.db",
            "notes.md",
            "app-v1-2026103öT101500Z.db",
        ] {
            assert!(age_of(name).is_none(), "{name} is not a backup");
        }
    }

    #[test]
    fn names_made_by_the_migration_are_recognized() {
        let dir = temp_dir();
        let target = backup_path(&dir.path().join("app.db"), "v1").expect("backup name");
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        assert!(age_of(name).is_some(), "{name}");
    }

    #[test]
    fn no_backups_folder_means_no_copies() {
        let dir = temp_dir();
        assert_eq!(
            summary(dir.path()).expect("summary"),
            BackupSummary::default()
        );
        assert_eq!(prune(dir.path(), 3).expect("prune"), 0);
        assert!(
            !dir.path().join(BACKUP_DIR).exists(),
            "pruning creates nothing"
        );
    }

    #[test]
    fn the_summary_counts_copies_with_their_side_files() {
        let dir = temp_dir();
        let backups = backups(dir.path());
        write(&backups, "app-v1-20261030T101500Z.db", 100);
        write(&backups, "app-broken-20261101T090000Z.db", 40);
        write(&backups, "app-broken-20261101T090000Z.db-wal", 2);
        write(&backups, "notes.txt", 1000);

        assert_eq!(
            summary(dir.path()).expect("summary"),
            BackupSummary {
                copies: 2,
                bytes: 142,
            }
        );
    }

    #[test]
    fn pruning_keeps_the_newest_copies_and_everything_that_is_not_a_copy() {
        let dir = temp_dir();
        let backups = backups(dir.path());
        write(&backups, "app-v1-20261028T080000Z.db", 1);
        write(&backups, "app-broken-20261029T080000Z.db", 1);
        write(&backups, "app-broken-20261029T080000Z.db-wal", 1);
        write(&backups, "app-broken-20261029T080000Z.db-shm", 1);
        write(&backups, "app-v1-20261030T080000Z.db", 1);
        // Same second: the counter decides.
        write(&backups, "app-v2-20261031T080000Z.db", 1);
        write(&backups, "app-v2-20261031T080000Z-2.db", 1);
        write(&backups, "app-v2-20261031T080000Z-10.db", 1);
        // Not Liurium's: stays whatever its age.
        write(&backups, "app.db", 1);
        write(&backups, "my-copy.db", 1);
        write(&backups, "project-v1-20261001T080000Z.db", 1);
        fs::create_dir(backups.join("app-v1-20261001T080000Z.db")).expect("folder");
        let outside = temp_dir();
        junction(&backups.join("app-v1-20261002T080000Z.db"), outside.path());

        assert_eq!(prune(dir.path(), 3).expect("prune"), 3);

        assert_eq!(
            names(&backups),
            [
                "app-v1-20261001T080000Z.db",
                "app-v1-20261002T080000Z.db",
                "app-v2-20261031T080000Z-10.db",
                "app-v2-20261031T080000Z-2.db",
                "app-v2-20261031T080000Z.db",
                "app.db",
                "my-copy.db",
                "project-v1-20261001T080000Z.db",
            ]
        );
        assert!(outside.path().exists(), "the junction's target stays");
        assert_eq!(summary(dir.path()).expect("summary").copies, 3);
    }

    #[test]
    fn pruning_with_few_copies_deletes_nothing() {
        let dir = temp_dir();
        let backups = backups(dir.path());
        write(&backups, "app-v1-20261028T080000Z.db", 1);
        write(&backups, "app-v1-20261029T080000Z.db", 1);

        assert_eq!(prune(dir.path(), 3).expect("prune"), 0);
        assert_eq!(names(&backups).len(), 2);
    }
}
