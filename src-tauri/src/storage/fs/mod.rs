//! Every file access below a project root (ADR-0016, Security Model). Paths come in
//! as `RelPath`; links are followed only while their real target stays inside the
//! root; writes are atomic and never replace a file that changed on disk.
//!
//! Known gap: a link swapped in between the check and the access by another local
//! process. Closing it needs handle-based Windows calls (`unsafe` or a new crate).

mod error;
mod organize;
#[cfg(test)]
mod organize_tests;
mod path;
#[cfg(test)]
mod tests;
mod walk;
#[cfg(test)]
mod walk_tests;

use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub use error::FsError;
pub use organize::{TRASH_DIR, utc_stamp};
pub use path::{PathRule, RelPath};
pub use walk::{
    FoundImage, FoundNote, IMAGE_ENDINGS, Limits, NOTE_ENDINGS, SKIPPED_FOLDERS, Skipped, Walk,
    is_image_name,
};

/// Liurium's own folder in every project (ADR-0016).
pub const LIURIUM_DIR: &str = ".liurium";

/// Written only by their own modules, never through generic paths.
const PROTECTED: [&str; 2] = [LIURIUM_DIR, ".git"];

/// Ends the name of a temp file that an interrupted write left behind
/// (cleaned up when a project opens, M2-005).
pub const TEMP_SUFFIX: &str = ".liurium-tmp";

/// What Liurium last saw of a file. Modified time and size (M2-003 decision D2): a
/// change of the same size within one tick of the Windows clock goes unnoticed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub len: u64,
    pub modified: SystemTime,
}

impl Stamp {
    fn of(metadata: &Metadata) -> io::Result<Self> {
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

/// What a write expects to find at the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    /// No file yet.
    New,
    /// The file exactly as Liurium last read or wrote it.
    Unchanged(Stamp),
}

/// A project folder, resolved once. All access below it goes through here.
#[derive(Debug, Clone)]
pub struct ProjectRoot {
    path: PathBuf,
}

impl ProjectRoot {
    pub fn open(folder: &Path) -> Result<Self, FsError> {
        let path = fs::canonicalize(folder)?;
        if !fs::metadata(&path)?.is_dir() {
            return Err(FsError::WrongKind);
        }
        Ok(Self { path })
    }

    /// Canonical, with the `\\?\` prefix.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether an existing absolute path lies inside this project, for paths from
    /// the folder picker or the registry (M2-005, M2-006).
    pub fn contains(&self, path: &Path) -> Result<bool, FsError> {
        Ok(is_inside(&self.path, &fs::canonicalize(path)?))
    }

    /// Reads a whole file, refusing files larger than `max_len` bytes.
    pub fn read(&self, rel: &RelPath, max_len: u64) -> Result<(Vec<u8>, Stamp), FsError> {
        read_whole(&self.resolve(rel)?, max_len)
    }

    /// The same for a file the page asks for (M3-013): a link into `.liurium` or `.git`
    /// is refused too, though it stays inside the project.
    pub fn read_unprotected(
        &self,
        rel: &RelPath,
        max_len: u64,
    ) -> Result<(Vec<u8>, Stamp), FsError> {
        read_whole(&self.writable(rel)?, max_len)
    }

    /// Size and modified time of an existing file, without reading it.
    pub fn stamp(&self, rel: &RelPath) -> Result<Stamp, FsError> {
        let metadata = fs::metadata(self.resolve(rel)?)?;
        if !metadata.is_file() {
            return Err(FsError::WrongKind);
        }
        Ok(Stamp::of(&metadata)?)
    }

    /// Whether an existing file has the read-only attribute.
    pub fn is_read_only(&self, rel: &RelPath) -> Result<bool, FsError> {
        Ok(fs::metadata(self.resolve(rel)?)?.permissions().readonly())
    }

    /// Replaces or creates a file in one step: the content goes to a temp file in
    /// the same folder first, then the temp file is renamed over the target.
    pub fn write(&self, rel: &RelPath, bytes: &[u8], expect: Expect) -> Result<Stamp, FsError> {
        self.stage(rel, bytes, expect)?.commit()
    }

    pub fn create_dir(&self, rel: &RelPath) -> Result<(), FsError> {
        fs::create_dir_all(self.writable(rel)?)?;
        Ok(())
    }

    /// The folder's own name, for a project's default display name.
    pub fn name(&self) -> Option<String> {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }

    /// The path as Windows shows it, without the `\\?\` prefix.
    pub fn display(&self) -> String {
        let text = self.path.to_string_lossy();
        if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{share}")
        } else {
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
        }
    }

    /// Whether this folder can hold a project: not a whole drive or share (opening
    /// would walk all of it), and not inside a `.liurium` or `.git` folder.
    pub fn suitable(&self) -> bool {
        let protected = self.path.components().any(|part| {
            PROTECTED
                .iter()
                .any(|name| part.as_os_str().eq_ignore_ascii_case(name))
        });
        self.name().is_some() && !protected
    }

    /// `.liurium` in this folder, if present. A link there is refused: Liurium's own
    /// data must not lead somewhere else.
    pub fn liurium_dir(&self) -> Result<Option<PathBuf>, FsError> {
        let path = self.path.join(LIURIUM_DIR);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.is_symlink() => Ok(Some(path)),
            Ok(_) => Err(FsError::WrongKind),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Creates `.liurium`; fails if anything already has that name.
    pub fn create_liurium_dir(&self) -> Result<PathBuf, FsError> {
        let path = self.path.join(LIURIUM_DIR);
        fs::create_dir(&path).map_err(not_writable)?;
        Ok(path)
    }

    /// Removes the temp files that interrupted writes left behind (`stage` names
    /// them), and nothing else. Does not follow links and skips `.git`. Best effort:
    /// a file that cannot be removed stays for the next time. Returns how many went.
    pub fn remove_temp_files(&self) -> usize {
        let mut removed = 0;
        let mut folders = vec![self.path.clone()];
        while let Some(folder) = folders.pop() {
            let Ok(entries) = fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let name = entry.file_name();
                if kind.is_symlink() {
                    continue;
                } else if kind.is_dir() {
                    if !name.eq_ignore_ascii_case(".git") {
                        folders.push(entry.path());
                    }
                } else if is_temp_name(&name) && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Where `rel` really is. Every existing part is canonicalized, which follows
    /// links, and must stay inside the root. Parts that do not exist yet cannot be
    /// links.
    fn resolve(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let mut real = self.path.clone();
        let mut parts = rel.parts();
        while let Some(part) = parts.next() {
            let next = real.join(part);
            match fs::symlink_metadata(&next) {
                Ok(metadata) => {
                    real = fs::canonicalize(&next).map_err(|error| {
                        if metadata.is_symlink() && error.kind() == io::ErrorKind::NotFound {
                            FsError::BrokenLink
                        } else {
                            error.into()
                        }
                    })?;
                    if !is_inside(&self.path, &real) {
                        return Err(FsError::OutsideRoot);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    real = next;
                    real.extend(parts);
                    return Ok(real);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(real)
    }

    /// Like `resolve`, but refuses `.liurium` and `.git` anywhere in the real path,
    /// so a link cannot lead there either.
    fn writable(&self, rel: &RelPath) -> Result<PathBuf, FsError> {
        let real = self.resolve(rel)?;
        let protected = real
            .components()
            .skip(self.path.components().count())
            .any(|part| {
                PROTECTED
                    .iter()
                    .any(|name| part.as_os_str().eq_ignore_ascii_case(name))
            });
        if protected {
            return Err(FsError::Protected);
        }
        Ok(real)
    }

    /// First half of `write`: the new content, flushed to disk, in a temp file next
    /// to the target.
    fn stage(&self, rel: &RelPath, bytes: &[u8], expect: Expect) -> Result<Staged, FsError> {
        let target = self.writable(rel)?;
        check_expectation(&target, expect)?;
        let folder = target.parent().ok_or(FsError::WrongKind)?;
        if !fs::metadata(folder)?.is_dir() {
            return Err(FsError::WrongKind);
        }
        let (temp, file) = create_temp(folder)?;
        let staged = Staged {
            temp,
            target,
            expect,
            committed: false,
        };
        fill(file, bytes)?;
        Ok(staged)
    }
}

/// A written temp file waiting to replace its target. Dropped without a commit, it
/// removes the temp file.
struct Staged {
    temp: PathBuf,
    target: PathBuf,
    expect: Expect,
    committed: bool,
}

impl Staged {
    /// Second half of `write`: checks the target again right before replacing it.
    fn commit(mut self) -> Result<Stamp, FsError> {
        check_expectation(&self.target, self.expect)?;
        fs::rename(&self.temp, &self.target)?;
        self.committed = true;
        Ok(Stamp::of(&fs::metadata(&self.target)?)?)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.committed {
            // Best effort: an error has already been returned, and a leftover temp
            // file is removed when the project opens next (M2-005).
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// Never replaces a file that changed, a read-only file, or a folder. `fs::rename`
/// would replace a read-only file (it retries with `FileRenameInfoEx`), so that is
/// checked here.
fn check_expectation(target: &Path, expect: Expect) -> Result<(), FsError> {
    match (fs::metadata(target), expect) {
        (Err(error), Expect::New) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        (Err(error), Expect::Unchanged(_)) if error.kind() == io::ErrorKind::NotFound => {
            Err(FsError::Changed)
        }
        (Err(error), _) => Err(error.into()),
        (Ok(_), Expect::New) => Err(FsError::AlreadyExists),
        (Ok(metadata), Expect::Unchanged(stamp)) => {
            if !metadata.is_file() {
                Err(FsError::WrongKind)
            } else if metadata.permissions().readonly() {
                Err(FsError::ReadOnly)
            } else if Stamp::of(&metadata)? != stamp {
                Err(FsError::Changed)
            } else {
                Ok(())
            }
        }
    }
}

fn create_temp(folder: &Path) -> Result<(PathBuf, File), FsError> {
    for _ in 0..16 {
        let temp = folder.join(format!(".{}{TEMP_SUFFIX}", unique_token()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(FsError::AlreadyExists)
}

/// Unique within this process and unlikely across processes; `create_new` catches
/// the rest.
fn unique_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.subsec_nanos());
    format!("{:x}-{count:x}-{nanos:x}", std::process::id())
}

/// Whether a file name is exactly what `create_temp` makes: `.` + `unique_token` +
/// `TEMP_SUFFIX`. A user's file that merely ends the same way does not match.
pub fn is_temp_name(name: &OsStr) -> bool {
    let Some(token) = name
        .to_str()
        .and_then(|name| name.strip_prefix('.'))
        .and_then(|name| name.strip_suffix(TEMP_SUFFIX))
    else {
        return false;
    };
    let parts: Vec<&str> = token.split('-').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

/// Takes the file so it is closed before the rename.
fn fill(mut file: File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

/// Creates a small file of Liurium's own (in `.liurium`); never replaces an existing
/// one. A failed write removes the partial file again.
pub fn create_file(path: &Path, bytes: &[u8]) -> Result<(), FsError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(not_writable)?;
    fill(file, bytes).map_err(|error| {
        let _ = fs::remove_file(path);
        FsError::from(error)
    })
}

/// Creating something in a folder the user may not write to says so, instead of a
/// bare file error.
fn not_writable(error: io::Error) -> FsError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        FsError::ReadOnly
    } else {
        error.into()
    }
}

/// Whether two existing absolute paths name the same file or folder.
pub fn same_path(a: &Path, b: &Path) -> Result<bool, FsError> {
    let (a, b) = (fs::canonicalize(a)?, fs::canonicalize(b)?);
    Ok(a.components().count() == b.components().count() && is_inside(&a, &b))
}

/// Whether the existing `path` is the existing folder `root` or lies inside it.
pub fn inside(root: &Path, path: &Path) -> Result<bool, FsError> {
    Ok(is_inside(
        &fs::canonicalize(root)?,
        &fs::canonicalize(path)?,
    ))
}

/// Both paths canonical. Compared part by part, ignoring case as Windows does for
/// names (Unicode lowercase, close to NTFS's own case table).
/// A whole file, refusing files larger than `max_len` bytes.
fn read_whole(real: &Path, max_len: u64) -> Result<(Vec<u8>, Stamp), FsError> {
    if !fs::metadata(real)?.is_file() {
        return Err(FsError::WrongKind);
    }
    let file = File::open(real)?;
    // Taken before reading: a change during the read makes a later write fail
    // with `Changed` instead of hiding it.
    let metadata = file.metadata()?;
    let too_large = |len| FsError::TooLarge { len, max: max_len };
    if metadata.len() > max_len {
        return Err(too_large(metadata.len()));
    }
    let mut bytes = Vec::new();
    file.take(max_len.saturating_add(1))
        .read_to_end(&mut bytes)?;
    let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if len > max_len {
        return Err(too_large(len));
    }
    Ok((bytes, Stamp::of(&metadata)?))
}

fn is_inside(root: &Path, path: &Path) -> bool {
    let mut parts = path.components();
    root.components().all(|root_part| {
        parts
            .next()
            .is_some_and(|part| same_name(root_part.as_os_str(), part.as_os_str()))
    })
}

fn same_name(a: &OsStr, b: &OsStr) -> bool {
    match (a.to_str(), b.to_str()) {
        (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
        _ => a == b,
    }
}
