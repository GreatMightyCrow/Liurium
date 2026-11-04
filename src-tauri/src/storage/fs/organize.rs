//! Creating, renaming, moving, and trashing items below a project root (M3-004).
//! Nothing is ever replaced or removed for good: a rename checks that the target is
//! free, and deleting moves the item into `.liurium/trash`. Links and junctions are
//! never renamed, moved, or trashed, so nothing acts on a target elsewhere.
//!
//! Known gap (as in `mod.rs`): another program creating exactly the target name
//! between the check and the rename. Windows' rename would replace a file then.

use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::{Expect, FsError, PROTECTED, ProjectRoot, RelPath, is_inside, not_writable, same_name};

/// Inside `.liurium`; one folder per delete, named by its UTC time.
pub const TRASH_DIR: &str = "trash";

/// The line that keeps Git from committing the trash.
const TRASH_IGNORE: &str = "trash/";

impl ProjectRoot {
    /// Creates one new folder; its parent must exist. Fails if anything has the name.
    pub fn create_folder(&self, rel: &RelPath) -> Result<(), FsError> {
        let target = self.new_entry(rel)?;
        fs::create_dir(target).map_err(not_writable)
    }

    /// Whether an existing item is a folder (not following a link at its own name).
    pub fn is_folder(&self, rel: &RelPath) -> Result<bool, FsError> {
        Ok(fs::symlink_metadata(self.entry(rel)?)?.is_dir())
    }

    /// Renames or moves a note or folder. The target must be free; only a change of
    /// case may keep the same name.
    pub fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FsError> {
        let source = self.entry(from)?;
        let case_only = from.parent() == to.parent()
            && same_name(OsStr::new(from.file_name()), OsStr::new(to.file_name()));
        let target = if case_only {
            self.entry_path(to)?
        } else {
            self.new_entry(to)?
        };
        if fs::symlink_metadata(&source)?.is_dir() {
            let parent = target.parent().ok_or(FsError::WrongKind)?;
            if is_inside(&source, parent) {
                return Err(FsError::IntoItself);
            }
        }
        fs::rename(&source, &target).map_err(not_writable)
    }

    /// Moves a note or folder into `.liurium/trash/<UTC time>/<its path>`, so it can
    /// be put back by hand. Returns its new place below the project root.
    pub fn trash(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let source = self.entry(rel)?;
        let liurium = self.liurium_dir()?.ok_or(FsError::NotFound)?;
        let trash = liurium.join(TRASH_DIR);
        create_real_dir(&trash)?;
        ignore_trash(&liurium)?;
        let stamp = utc_stamp(SystemTime::now());
        let mut batch = trash.join(&stamp);
        let mut count = 1;
        while fs::symlink_metadata(&batch).is_ok() {
            count += 1;
            batch = trash.join(format!("{stamp}-{count}"));
        }
        let mut target = batch;
        if let Some(parent) = rel.parent() {
            target.extend(parent.parts());
        }
        fs::create_dir_all(&target)?;
        target.push(rel.file_name());
        fs::rename(&source, &target).map_err(not_writable)?;
        Ok(target)
    }

    /// An existing item at `rel`: parents may be links inside the project, but the
    /// item itself must not be a link, nor `.liurium` or `.git`.
    fn entry(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let path = self.entry_path(rel)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_symlink() {
            return Err(FsError::IsLink);
        }
        Ok(path)
    }

    /// Where `rel` is, with its parents resolved and checked, without looking at the
    /// item itself.
    fn entry_path(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let name = rel.file_name();
        if PROTECTED
            .iter()
            .any(|protected| name.eq_ignore_ascii_case(protected))
        {
            return Err(FsError::Protected);
        }
        let parent = match rel.parent() {
            Some(parent) => self.writable(&parent)?,
            None => self.path().to_path_buf(),
        };
        if !fs::metadata(&parent)?.is_dir() {
            return Err(FsError::WrongKind);
        }
        Ok(parent.join(name))
    }

    /// A place for a new item: its parent exists, nothing has its name yet.
    fn new_entry(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let path = self.entry_path(rel)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => Err(FsError::AlreadyExists),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path),
            Err(error) => Err(error.into()),
        }
    }
}

/// Creates a folder of Liurium's own unless it exists; a link there is refused.
fn create_real_dir(path: &Path) -> Result<(), FsError> {
    match fs::create_dir(path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(not_writable(error)),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.is_symlink() {
        Ok(())
    } else {
        Err(FsError::WrongKind)
    }
}

/// Adds `trash/` to `.liurium/.gitignore` if it is not there yet. The file is
/// Liurium's own; the change is written atomically.
fn ignore_trash(liurium: &Path) -> Result<(), FsError> {
    let path = liurium.join(".gitignore");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    if text.lines().any(|line| line.trim() == TRASH_IGNORE) {
        return Ok(());
    }
    let mut updated = text;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str("# Deleted notes and folders, kept until emptied in Liurium.\n");
    updated.push_str(TRASH_IGNORE);
    updated.push('\n');
    let root = ProjectRoot {
        path: liurium.to_path_buf(),
    };
    let name = RelPath::name(".gitignore")?;
    let expect = match fs::metadata(&path) {
        Ok(metadata) => Expect::Unchanged(super::Stamp::of(&metadata)?),
        Err(_) => Expect::New,
    };
    root.stage(&name, updated.as_bytes(), expect)?.commit()?;
    Ok(())
}

/// `20261104T201530Z`, from the system clock without a date crate.
pub fn utc_stamp(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant, "chrono-Compatible
/// Low-Level Date Algorithms").
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
