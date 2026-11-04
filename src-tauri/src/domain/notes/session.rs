//! The note open in the editor (M3-003, owner decisions Q1 and Q2). Rust keeps the
//! latest text from the page (the draft), so a close or a project change can save
//! it without the page. A write only replaces the file as Liurium last read or wrote
//! it; a change made outside stops saving until the user chooses.

use crate::storage::fs::{Expect, FsError, ProjectRoot, RelPath, Stamp};

use super::text::{
    self, LineEnding, NoteText, TextError, conflict_path, decode, encode, most_common,
    with_line_breaks,
};

/// Larger files are not opened for editing.
pub const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

/// Tried names for a conflict copy: `(conflict)`, `(conflict 2)`, …
const MAX_CONFLICT_COPIES: usize = 100;

#[derive(Debug)]
pub enum NoteError {
    Fs(FsError),
    NotUtf8,
    /// The note cannot be written (see `ReadOnly`).
    ReadOnly,
    /// The path names another note than the open one.
    NotOpen,
}

impl From<FsError> for NoteError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<TextError> for NoteError {
    fn from(error: TextError) -> Self {
        match error {
            TextError::NotUtf8 => Self::NotUtf8,
        }
    }
}

/// Why a note opened read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnly {
    /// The whole project is write-protected.
    Project,
    /// The file is write-protected.
    File,
    /// The file mixes line endings; it can be made uniform first.
    LineEndings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Saved {
    /// On disk as the page sent it.
    Saved,
    /// Kept in Rust, not written yet.
    Draft,
    /// The file changed outside Liurium; nothing is written until the user chooses.
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// Drop the draft and read the file again.
    Reload,
    /// Write the draft over the change made outside.
    Overwrite,
    /// Write the draft as a new note next to it and continue there.
    KeepBoth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Reloaded,
    Saved,
    KeptBoth { path: RelPath },
}

#[derive(Debug)]
pub struct Session {
    path: RelPath,
    stamp: Stamp,
    bom: bool,
    ending: LineEnding,
    read_only: Option<ReadOnly>,
    /// The text as on disk, with the file's line endings.
    saved: String,
    /// Newer text from the page, not written yet.
    draft: Option<String>,
    conflict: bool,
}

impl Session {
    /// Reads a note. With `unify`, a note with mixed line endings is first written
    /// with the most common one (the page asked the user).
    pub fn open(
        root: &ProjectRoot,
        path: RelPath,
        project_read_only: bool,
        unify: bool,
    ) -> Result<Self, NoteError> {
        let (bytes, mut stamp) = root.read(&path, MAX_NOTE_BYTES)?;
        let NoteText {
            mut text,
            bom,
            mut ending,
        } = decode(&bytes)?;
        let file_read_only = root.is_read_only(&path)?;
        if unify && ending == LineEnding::Mixed && !project_read_only && !file_read_only {
            ending = most_common(&text);
            text = with_line_breaks(&text, ending.separator().unwrap_or("\r\n"));
            stamp = root.write(&path, &encode(&text, bom, ending), Expect::Unchanged(stamp))?;
        }
        let read_only = if project_read_only {
            Some(ReadOnly::Project)
        } else if file_read_only {
            Some(ReadOnly::File)
        } else if ending == LineEnding::Mixed {
            Some(ReadOnly::LineEndings)
        } else {
            None
        };
        Ok(Self {
            path,
            stamp,
            bom,
            ending,
            read_only,
            saved: text,
            draft: None,
            conflict: false,
        })
    }

    pub fn path(&self) -> &RelPath {
        &self.path
    }

    pub fn ending(&self) -> LineEnding {
        self.ending
    }

    pub fn read_only(&self) -> Option<ReadOnly> {
        self.read_only
    }

    /// What the editor shows: the draft if there is one.
    pub fn text(&self) -> &str {
        self.draft.as_deref().unwrap_or(&self.saved)
    }

    pub fn has_draft(&self) -> bool {
        self.draft.is_some()
    }

    pub fn in_conflict(&self) -> bool {
        self.conflict
    }

    /// Whether `path` names this note; paths compare without case, as on Windows.
    pub fn is(&self, path: &RelPath) -> bool {
        self.path.to_string().to_lowercase() == path.to_string().to_lowercase()
    }

    /// Keeps the page's text; with `save`, writes it.
    pub fn update(
        &mut self,
        root: &ProjectRoot,
        text: &str,
        save: bool,
    ) -> Result<Saved, NoteError> {
        if self.read_only.is_some() {
            return Err(NoteError::ReadOnly);
        }
        let text = match self.ending.separator() {
            Some(separator) => with_line_breaks(text, separator),
            None => text.to_owned(),
        };
        self.draft = (text != self.saved).then_some(text);
        if self.draft.is_none() {
            return Ok(Saved::Saved);
        }
        if !save {
            return Ok(Saved::Draft);
        }
        self.save(root)
    }

    /// Writes the draft, if there is one and no conflict is waiting.
    pub fn save(&mut self, root: &ProjectRoot) -> Result<Saved, NoteError> {
        let Some(draft) = self.draft.clone() else {
            return Ok(Saved::Saved);
        };
        if self.conflict {
            return Ok(Saved::Conflict);
        }
        let bytes = encode(&draft, self.bom, self.ending);
        match root.write(&self.path, &bytes, Expect::Unchanged(self.stamp)) {
            Ok(stamp) => {
                self.stamp = stamp;
                self.saved = draft;
                self.draft = None;
                Ok(Saved::Saved)
            }
            Err(FsError::Changed) => {
                self.conflict = true;
                Ok(Saved::Conflict)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// The user's answer to a conflict. Without a conflict, only `Reload` does
    /// anything.
    pub fn resolve(
        &mut self,
        root: &ProjectRoot,
        choice: Choice,
        project_read_only: bool,
    ) -> Result<Resolved, NoteError> {
        match choice {
            Choice::Reload => {
                *self = Self::open(root, self.path.clone(), project_read_only, false)?;
                Ok(Resolved::Reloaded)
            }
            Choice::Overwrite => {
                let draft = self.draft.clone().unwrap_or_else(|| self.saved.clone());
                let bytes = encode(&draft, self.bom, self.ending);
                let expect = match root.stamp(&self.path) {
                    Ok(stamp) => Expect::Unchanged(stamp),
                    Err(FsError::NotFound) => Expect::New,
                    Err(error) => return Err(error.into()),
                };
                self.stamp = root.write(&self.path, &bytes, expect)?;
                self.saved = draft;
                self.draft = None;
                self.conflict = false;
                Ok(Resolved::Saved)
            }
            Choice::KeepBoth => {
                let draft = self.draft.clone().unwrap_or_else(|| self.saved.clone());
                let bytes = encode(&draft, self.bom, self.ending);
                for attempt in 1..=MAX_CONFLICT_COPIES {
                    let copy = conflict_path(&self.path, attempt)?;
                    match root.write(&copy, &bytes, Expect::New) {
                        Ok(stamp) => {
                            self.path = copy.clone();
                            self.stamp = stamp;
                            self.saved = draft;
                            self.draft = None;
                            self.conflict = false;
                            return Ok(Resolved::KeptBoth { path: copy });
                        }
                        Err(FsError::AlreadyExists) => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(FsError::AlreadyExists.into())
            }
        }
    }

    /// Saves before the note is left (switch, project change, close). A conflict
    /// keeps both, so nothing is lost without asking; other failures are returned.
    pub fn flush(&mut self, root: &ProjectRoot) -> Result<Option<Resolved>, NoteError> {
        if !self.has_draft() {
            return Ok(None);
        }
        match self.save(root)? {
            Saved::Conflict => self.resolve(root, Choice::KeepBoth, false).map(Some),
            Saved::Saved | Saved::Draft => Ok(None),
        }
    }

    /// Drops the draft (the user chose to close without saving).
    pub fn discard(&mut self) {
        self.draft = None;
        self.conflict = false;
    }
}

/// A path from the page, checked by the note rules.
pub fn note_path(text: &str) -> Result<RelPath, NoteError> {
    text::note_path(text).map_err(NoteError::Fs)
}
