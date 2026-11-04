//! Finding the Markdown notes of a project (M3-002, owner decisions Q1 and Q2). Only
//! reads. Real folders are walked first; links and junctions afterwards, and only
//! when their real target is inside the project and was not walked yet, so no note
//! is found twice and link loops end.

use std::{
    collections::{HashSet, VecDeque},
    fs::{self, DirEntry},
    io,
    os::windows::fs::FileTypeExt,
    path::{Path, PathBuf},
};

use super::{PROTECTED, ProjectRoot, RelPath, Stamp, is_inside};

/// Folders that hold build output or downloaded packages, never the user's notes
/// (owner, 2026-11-04). Compared without case. Names starting with `.` are skipped
/// as well.
pub const SKIPPED_FOLDERS: [&str; 7] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
];

/// File endings that make a note, compared without case.
pub const NOTE_ENDINGS: [&str; 2] = [".md", ".markdown"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The walk stops after this many notes.
    pub notes: usize,
    /// Folders deeper than this below the root are not opened.
    pub depth: usize,
}

impl Limits {
    pub const DEFAULT: Self = Self {
        notes: 100_000,
        depth: 64,
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundNote {
    pub path: RelPath,
    pub stamp: Stamp,
}

/// What the walk passed over, by reason. Only counts: names are untrusted and are
/// neither shown nor logged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Skipped {
    /// Links and junctions whose target is outside the project, or in `.liurium` or
    /// `.git`.
    pub links_outside: usize,
    /// Links whose target does not exist.
    pub broken_links: usize,
    /// Names that are not valid Unicode or that Windows rules refuse.
    pub bad_names: usize,
    /// Folders or entries that could not be read.
    pub unreadable: usize,
    /// Folders deeper than the depth limit.
    pub too_deep: usize,
}

impl Skipped {
    pub fn total(&self) -> usize {
        self.links_outside + self.broken_links + self.bad_names + self.unreadable + self.too_deep
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Walk {
    /// Sorted by path, without case first.
    pub notes: Vec<FoundNote>,
    pub skipped: Skipped,
    /// The note limit was reached; the project holds more notes than listed.
    pub truncated: bool,
    /// Folders with nothing in them at all, so a new folder shows up (M3-004).
    pub empty_folders: Vec<RelPath>,
}

/// A folder still to read: where it really is, and its path below the root.
struct Folder {
    real: PathBuf,
    rel: Option<RelPath>,
    depth: usize,
}

/// A link met during the walk, followed after all real folders.
struct Link {
    path: PathBuf,
    rel: RelPath,
    depth: usize,
    note: bool,
}

struct Walker<'a> {
    root: &'a ProjectRoot,
    limits: Limits,
    notes: Vec<FoundNote>,
    skipped: Skipped,
    truncated: bool,
    /// Real paths already walked, folders and notes, in lower case.
    seen: HashSet<String>,
    links: VecDeque<Link>,
    empty_folders: Vec<RelPath>,
}

impl ProjectRoot {
    /// Every note in the project by the rules above. Never writes.
    pub fn find_notes(&self, limits: Limits) -> Walk {
        let mut walker = Walker {
            root: self,
            limits,
            notes: Vec::new(),
            skipped: Skipped::default(),
            truncated: false,
            seen: HashSet::new(),
            links: VecDeque::new(),
            empty_folders: Vec::new(),
        };
        walker.seen.insert(key(self.path()));
        walker.walk(Folder {
            real: self.path().to_path_buf(),
            rel: None,
            depth: 0,
        });
        while let Some(link) = walker.links.pop_front() {
            if walker.truncated {
                break;
            }
            walker.follow(link);
        }
        walker.notes.sort_by(|a, b| {
            let (a, b) = (a.path.to_string(), b.path.to_string());
            a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(&b))
        });
        walker
            .empty_folders
            .sort_by_cached_key(|path| (path.to_string().to_lowercase(), path.to_string()));
        Walk {
            notes: walker.notes,
            skipped: walker.skipped,
            truncated: walker.truncated,
            empty_folders: walker.empty_folders,
        }
    }
}

impl Walker<'_> {
    /// Reads real folders depth first; links are queued, not followed.
    fn walk(&mut self, start: Folder) {
        let mut folders = vec![start];
        while let Some(folder) = folders.pop() {
            let Some(entries) = self.entries(&folder.real) else {
                continue;
            };
            if entries.is_empty()
                && let Some(rel) = &folder.rel
            {
                self.empty_folders.push(rel.clone());
            }
            // Reversed onto the stack, so subfolders are read in name order.
            let mut subfolders = Vec::new();
            for entry in entries {
                if self.truncated {
                    return;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    self.skipped.bad_names += 1;
                    continue;
                };
                let Ok(kind) = entry.file_type() else {
                    self.skipped.unreadable += 1;
                    continue;
                };
                // A junction or directory link is not `is_dir`, but `is_symlink_dir`.
                let is_folder = kind.is_dir() || kind.is_symlink_dir();
                if !wanted(&name, is_folder) {
                    continue;
                }
                let Some(rel) = child(folder.rel.as_ref(), &name) else {
                    self.skipped.bad_names += 1;
                    continue;
                };
                let depth = folder.depth + 1;
                if kind.is_symlink() {
                    self.links.push_back(Link {
                        path: entry.path(),
                        rel,
                        depth,
                        note: !is_folder,
                    });
                } else if is_folder {
                    if depth > self.limits.depth {
                        self.skipped.too_deep += 1;
                        continue;
                    }
                    let real = folder.real.join(&name);
                    // Inside a linked folder, a subfolder may have been walked already
                    // through another link.
                    if !self.seen.insert(key(&real)) {
                        continue;
                    }
                    subfolders.push(Folder {
                        real,
                        rel: Some(rel),
                        depth,
                    });
                } else if kind.is_file() {
                    if !self.seen.insert(key(&folder.real.join(&name))) {
                        continue;
                    }
                    match entry.metadata().and_then(|metadata| Stamp::of(&metadata)) {
                        Ok(stamp) => self.add(rel, stamp),
                        Err(_) => self.skipped.unreadable += 1,
                    }
                }
            }
            folders.extend(subfolders.into_iter().rev());
        }
    }

    /// A link is followed when its real target is inside the project, outside
    /// `.liurium` and `.git`, and not walked yet.
    fn follow(&mut self, link: Link) {
        let real = match fs::canonicalize(&link.path) {
            Ok(real) => real,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.skipped.broken_links += 1;
                return;
            }
            Err(_) => {
                self.skipped.unreadable += 1;
                return;
            }
        };
        if !is_inside(self.root.path(), &real) || self.protected(&real) {
            self.skipped.links_outside += 1;
            return;
        }
        if !self.seen.insert(key(&real)) {
            // Already found through its real path or an earlier link.
            return;
        }
        let Ok(metadata) = fs::metadata(&real) else {
            self.skipped.unreadable += 1;
            return;
        };
        if link.note && metadata.is_file() {
            match Stamp::of(&metadata) {
                Ok(stamp) => self.add(link.rel, stamp),
                Err(_) => self.skipped.unreadable += 1,
            }
        } else if !link.note && metadata.is_dir() {
            if link.depth > self.limits.depth {
                self.skipped.too_deep += 1;
                return;
            }
            self.walk(Folder {
                real,
                rel: Some(link.rel),
                depth: link.depth,
            });
        }
    }

    fn add(&mut self, path: RelPath, stamp: Stamp) {
        if self.notes.len() >= self.limits.notes {
            self.truncated = true;
            return;
        }
        self.notes.push(FoundNote { path, stamp });
    }

    /// The entries of a folder in name order, without case first.
    fn entries(&mut self, folder: &Path) -> Option<Vec<DirEntry>> {
        let Ok(read) = fs::read_dir(folder) else {
            self.skipped.unreadable += 1;
            return None;
        };
        let mut entries = Vec::new();
        for entry in read {
            match entry {
                Ok(entry) => entries.push(entry),
                Err(_) => self.skipped.unreadable += 1,
            }
        }
        entries.sort_by_cached_key(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.to_lowercase(), name)
        });
        Some(entries)
    }

    fn protected(&self, real: &Path) -> bool {
        real.components()
            .skip(self.root.path().components().count())
            .any(|part| {
                PROTECTED
                    .iter()
                    .any(|name| part.as_os_str().eq_ignore_ascii_case(name))
            })
    }
}

/// Whether a folder is entered or a file counts as a note, by its name alone.
fn wanted(name: &str, is_folder: bool) -> bool {
    if name.starts_with('.') {
        return false;
    }
    let lower = name.to_lowercase();
    if is_folder {
        !SKIPPED_FOLDERS.contains(&lower.as_str())
    } else {
        NOTE_ENDINGS.iter().any(|ending| lower.ends_with(ending))
    }
}

fn child(parent: Option<&RelPath>, name: &str) -> Option<RelPath> {
    match parent {
        Some(parent) => parent.child(name).ok(),
        None => RelPath::name(name).ok(),
    }
}

/// Paths compared without case, as Windows names are.
fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}
