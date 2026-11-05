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
    /// The file is gone; nothing is written, so it does not come back unasked (M3-008).
    Gone,
}

/// What a look at the disk found (M3-008, owner decisions Q2 to Q4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outside {
    /// Nothing to do for the page.
    Same,
    /// No unsaved text: the note now holds the file's new text.
    Reloaded,
    /// Unsaved text and a changed or unreadable file: saving waits for a choice.
    Conflict,
    /// The file is gone and no new note has its text.
    Gone,
    /// The note now lives at another path.
    Moved,
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
    /// The file was not found at the last look (M3-008).
    gone: bool,
    /// Counts automatic reloads and reloads the user chose. Text from the page says
    /// which one it is based on, so typing during a reload cannot overwrite the file.
    revision: u64,
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
            gone: false,
            revision: 0,
        })
    }

    pub fn is_gone(&self) -> bool {
        self.gone
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Whether the file differs from what this session last read or wrote. A file
    /// already known to be gone, or a conflict already waiting, is nothing new.
    pub fn differs_on_disk(&self, root: &ProjectRoot) -> bool {
        match root.stamp(&self.path) {
            Ok(stamp) => stamp != self.stamp && !self.conflict,
            Err(_) => !self.gone,
        }
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

    /// `update` for text based on a given revision. Text based on an older one was
    /// typed before a reload, so it must not replace the file: it waits for a choice.
    pub fn update_at(
        &mut self,
        root: &ProjectRoot,
        text: &str,
        save: bool,
        revision: u64,
    ) -> Result<Saved, NoteError> {
        if revision == self.revision {
            return self.update(root, text, save);
        }
        let saved = self.update(root, text, false)?;
        if saved == Saved::Draft {
            self.conflict = true;
            return Ok(Saved::Conflict);
        }
        Ok(saved)
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
        // `Unchanged` also refuses a file that is gone, so it does not come back unasked.
        match root.write(&self.path, &bytes, Expect::Unchanged(self.stamp)) {
            Ok(stamp) => {
                self.stamp = stamp;
                self.saved = draft;
                self.draft = None;
                self.gone = false;
                Ok(Saved::Saved)
            }
            Err(FsError::Changed) => {
                if matches!(root.stamp(&self.path), Err(FsError::NotFound)) {
                    self.gone = true;
                    return Ok(Saved::Gone);
                }
                self.conflict = true;
                Ok(Saved::Conflict)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Looks at the disk and brings the session in line (M3-008). `recent` lists the
    /// notes that appeared lately, newest last. Only what is on disk decides, so a
    /// report from Windows that was lost, doubled, or out of order changes nothing.
    pub fn reconcile(
        &mut self,
        root: &ProjectRoot,
        project_read_only: bool,
        recent: &[RelPath],
    ) -> Result<Outside, NoteError> {
        // A rename that changes only upper and lower case leaves the file reachable.
        let spelling = recent.iter().rev().find(|path| self.is(path)).cloned();
        let respelled = spelling.is_some_and(|path| {
            let differs = path != self.path;
            if differs {
                self.path = path;
            }
            differs
        });
        let outside = match root.stamp(&self.path) {
            Ok(stamp) if stamp == self.stamp => {
                self.gone = false;
                Outside::Same
            }
            Ok(_) => self.changed_on_disk(root, project_read_only, recent)?,
            Err(FsError::NotFound) => self.missing(root, recent),
            Err(error) => return Err(error.into()),
        };
        Ok(if respelled && outside == Outside::Same {
            Outside::Moved
        } else {
            outside
        })
    }

    fn changed_on_disk(
        &mut self,
        root: &ProjectRoot,
        project_read_only: bool,
        recent: &[RelPath],
    ) -> Result<Outside, NoteError> {
        let (bytes, stamp) = match root.read(&self.path, MAX_NOTE_BYTES) {
            Ok(found) => found,
            Err(FsError::NotFound) => return Ok(self.missing(root, recent)),
            Err(FsError::TooLarge { .. }) => return Ok(self.unreadable()),
            Err(error) => return Err(error.into()),
        };
        let Ok(found) = decode(&bytes) else {
            return Ok(self.unreadable());
        };
        self.gone = false;
        let same_form = found.bom == self.bom && found.ending == self.ending;
        if same_form && found.text == self.saved {
            // Touched, not changed: any unsaved text still fits.
            self.stamp = stamp;
            self.conflict = false;
            return Ok(Outside::Same);
        }
        if same_form && self.draft.as_deref() == Some(found.text.as_str()) {
            // The file now says what the user typed: nothing is left to decide.
            self.saved = found.text;
            self.draft = None;
            self.stamp = stamp;
            self.conflict = false;
            return Ok(Outside::Same);
        }
        if self.draft.is_some() {
            self.conflict = true;
            return Ok(Outside::Conflict);
        }
        self.reload(root, project_read_only)?;
        Ok(Outside::Reloaded)
    }

    /// The old text stays and saving stops; the conflict bar offers the choices.
    fn unreadable(&mut self) -> Outside {
        self.gone = false;
        self.conflict = true;
        Outside::Conflict
    }

    fn missing(&mut self, root: &ProjectRoot, recent: &[RelPath]) -> Outside {
        if let Some((path, stamp)) = self.renamed_to(root, recent) {
            self.path = path;
            self.stamp = stamp;
            self.gone = false;
            self.conflict = false;
            return Outside::Moved;
        }
        self.gone = true;
        self.conflict = false;
        Outside::Gone
    }

    /// The one new note with exactly this note's last read text (owner decision Q4).
    /// An empty note never follows: every empty file would match.
    fn renamed_to(&self, root: &ProjectRoot, recent: &[RelPath]) -> Option<(RelPath, Stamp)> {
        if self.saved.is_empty() {
            return None;
        }
        let len = u64::try_from(encode(&self.saved, self.bom, self.ending).len()).ok()?;
        let mut found = None;
        for candidate in recent {
            if self.is(candidate) || root.stamp(candidate).map_or(true, |stamp| stamp.len != len) {
                continue;
            }
            let Ok((bytes, stamp)) = root.read(candidate, MAX_NOTE_BYTES) else {
                continue;
            };
            if decode(&bytes).is_ok_and(|note| note.text == self.saved) {
                if found.is_some() {
                    return None;
                }
                found = Some((candidate.clone(), stamp));
            }
        }
        found
    }

    /// Reads the file again; the page's older text can no longer be saved.
    fn reload(&mut self, root: &ProjectRoot, project_read_only: bool) -> Result<(), NoteError> {
        let revision = self.revision + 1;
        *self = Self::open(root, self.path.clone(), project_read_only, false)?;
        self.revision = revision;
        Ok(())
    }

    /// A deleted note's folder may be gone with it.
    fn make_parent(&self, root: &ProjectRoot, path: &RelPath) -> Result<(), NoteError> {
        if self.gone
            && let Some(parent) = path.parent()
        {
            root.create_dir(&parent)?;
        }
        Ok(())
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
                self.reload(root, project_read_only)?;
                Ok(Resolved::Reloaded)
            }
            Choice::Overwrite => {
                if project_read_only {
                    return Err(NoteError::ReadOnly);
                }
                let draft = self.draft.clone().unwrap_or_else(|| self.saved.clone());
                let bytes = encode(&draft, self.bom, self.ending);
                let expect = match root.stamp(&self.path) {
                    Ok(stamp) => Expect::Unchanged(stamp),
                    Err(FsError::NotFound) => Expect::New,
                    Err(error) => return Err(error.into()),
                };
                self.make_parent(root, &self.path)?;
                self.stamp = root.write(&self.path, &bytes, expect)?;
                self.saved = draft;
                self.draft = None;
                self.conflict = false;
                self.gone = false;
                Ok(Resolved::Saved)
            }
            Choice::KeepBoth => {
                let draft = self.draft.clone().unwrap_or_else(|| self.saved.clone());
                let bytes = encode(&draft, self.bom, self.ending);
                self.make_parent(root, &self.path)?;
                for attempt in 1..=MAX_CONFLICT_COPIES {
                    let copy = conflict_path(&self.path, attempt)?;
                    match root.write(&copy, &bytes, Expect::New) {
                        Ok(stamp) => {
                            self.path = copy.clone();
                            self.stamp = stamp;
                            self.saved = draft;
                            self.draft = None;
                            self.conflict = false;
                            self.gone = false;
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

    /// Saves before the note is left (switch, project change, close). A conflict or a
    /// deleted file keeps the text as a copy, so nothing is lost without asking and a
    /// deleted file does not come back; other failures are returned.
    pub fn flush(&mut self, root: &ProjectRoot) -> Result<Option<Resolved>, NoteError> {
        if !self.has_draft() {
            return Ok(None);
        }
        match self.save(root)? {
            Saved::Conflict | Saved::Gone => self.resolve(root, Choice::KeepBoth, false).map(Some),
            Saved::Saved | Saved::Draft => Ok(None),
        }
    }

    /// The note or a folder above it was renamed or moved (M3-004).
    pub fn rebase(&mut self, from: &RelPath, to: &RelPath) {
        if let Some(path) = self.path.rebase(from, to) {
            self.path = path;
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
