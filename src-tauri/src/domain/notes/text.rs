//! The text of a note file (M3-003): UTF-8 only, a BOM kept as it was, the file's
//! own line ending. Which paths may be opened as notes: the same rules as the walk
//! (M3-002), so the page cannot name `.liurium`, `.git`, or package folders.

use crate::storage::fs::{FsError, NOTE_ENDINGS, PathRule, RelPath, SKIPPED_FOLDERS};

const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Crlf,
    Lf,
    /// More than one kind, or a lone `\r`. Opens read-only until made uniform.
    Mixed,
}

impl LineEnding {
    pub fn separator(self) -> Option<&'static str> {
        match self {
            Self::Crlf => Some("\r\n"),
            Self::Lf => Some("\n"),
            Self::Mixed => None,
        }
    }
}

/// A note file decoded for the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteText {
    /// Without the BOM; line endings as in the file.
    pub text: String,
    pub bom: bool,
    pub ending: LineEnding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextError {
    /// UTF-16, another encoding, or binary data.
    NotUtf8,
}

pub fn decode(bytes: &[u8]) -> Result<NoteText, TextError> {
    if bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF") {
        return Err(TextError::NotUtf8);
    }
    let (bom, body) = match bytes.strip_prefix(BOM) {
        Some(body) => (true, body),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(body).map_err(|_| TextError::NotUtf8)?;
    // A NUL byte is valid UTF-8 but means binary data, not a note.
    if text.contains('\0') {
        return Err(TextError::NotUtf8);
    }
    Ok(NoteText {
        ending: ending_of(text),
        text: text.to_owned(),
        bom,
    })
}

/// The bytes to write: the BOM if the file had one, and the text with every line
/// break turned into `ending`, so a file never becomes mixed by an edit.
pub fn encode(text: &str, bom: bool, ending: LineEnding) -> Vec<u8> {
    let text = match ending.separator() {
        Some(separator) => with_line_breaks(text, separator),
        None => text.to_owned(),
    };
    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// CRLF or LF when the text uses only that; LF when it has no line break.
pub fn ending_of(text: &str) -> LineEnding {
    let (crlf, lf, cr) = counts(text);
    match (crlf, lf, cr) {
        (0, _, 0) => LineEnding::Lf,
        (_, 0, 0) => LineEnding::Crlf,
        _ => LineEnding::Mixed,
    }
}

/// The ending most lines of a mixed text use; CRLF on a tie, as on Windows.
pub fn most_common(text: &str) -> LineEnding {
    let (crlf, lf, cr) = counts(text);
    if lf > crlf && lf >= cr {
        LineEnding::Lf
    } else {
        LineEnding::Crlf
    }
}

/// `\r\n`, lone `\n`, lone `\r`.
fn counts(text: &str) -> (usize, usize, usize) {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf, mut cr) = (0, 0, 0);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    (crlf, lf, cr)
}

pub fn with_line_breaks(text: &str, separator: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str(separator);
            }
            '\n' => out.push_str(separator),
            c => out.push(c),
        }
    }
    out
}

/// A path from the page that may be opened as a note: a valid path below the
/// project, a note ending, no part starting with `.`, no skipped folder.
pub fn note_path(text: &str) -> Result<RelPath, FsError> {
    let path = RelPath::parse(text)?;
    let parts: Vec<&str> = path.parts().collect();
    let (name, folders) = parts
        .split_last()
        .ok_or(FsError::InvalidPath(PathRule::Empty))?;
    let lower = name.to_lowercase();
    let is_note = NOTE_ENDINGS.iter().any(|ending| lower.ends_with(ending));
    let hidden = parts.iter().any(|part| part.starts_with('.'));
    let skipped = folders
        .iter()
        .any(|folder| SKIPPED_FOLDERS.contains(&folder.to_lowercase().as_str()));
    if !is_note || hidden || skipped {
        return Err(FsError::InvalidPath(PathRule::Character));
    }
    Ok(path)
}

/// `Plan.md` → `Plan (conflict).md`, then `Plan (conflict 2).md`, … for `attempt`
/// 1, 2, …
pub fn conflict_path(path: &RelPath, attempt: usize) -> Result<RelPath, FsError> {
    let text = path.to_string();
    let (folder, name) = match text.rsplit_once('/') {
        Some((folder, name)) => (Some(folder), name),
        None => (None, text.as_str()),
    };
    let lower = name.to_lowercase();
    let ending = NOTE_ENDINGS
        .iter()
        .find(|ending| lower.ends_with(*ending))
        .map_or(0, |ending| ending.len());
    let (stem, extension) = name.split_at(name.len() - ending);
    let label = if attempt <= 1 {
        "conflict".to_owned()
    } else {
        format!("conflict {attempt}")
    };
    let new_name = format!("{stem} ({label}){extension}");
    match folder {
        Some(folder) => RelPath::parse(folder)?.child(&new_name),
        None => RelPath::name(&new_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_with_and_without_bom_round_trips_byte_for_byte() {
        for bytes in [
            b"# Plan\r\nline  \r\n\tend".as_slice(),
            b"\xEF\xBB\xBF# Plan\nline\n",
            b"",
            "Ünïcödé 名前\n".as_bytes(),
        ] {
            let note = decode(bytes).expect("decodes");
            assert_eq!(encode(&note.text, note.bom, note.ending), bytes);
        }
    }

    #[test]
    fn line_endings_are_recognized() {
        assert_eq!(ending_of("a\r\nb\r\n"), LineEnding::Crlf);
        assert_eq!(ending_of("a\nb\n"), LineEnding::Lf);
        assert_eq!(ending_of("no break"), LineEnding::Lf);
        assert_eq!(ending_of("a\r\nb\n"), LineEnding::Mixed);
        assert_eq!(ending_of("a\rb"), LineEnding::Mixed);
    }

    #[test]
    fn other_encodings_and_binary_data_are_refused() {
        for bytes in [
            b"\xFF\xFEa\x00".as_slice(),
            b"\xFE\xFF\x00a",
            b"caf\xE9",
            b"text\x00more",
        ] {
            assert_eq!(decode(bytes), Err(TextError::NotUtf8), "{bytes:?}");
        }
    }

    #[test]
    fn writing_keeps_one_line_ending_even_for_pasted_breaks() {
        assert_eq!(
            encode("a\nb\r\nc\rd", false, LineEnding::Crlf),
            b"a\r\nb\r\nc\r\nd"
        );
        assert_eq!(encode("a\r\nb\rc", false, LineEnding::Lf), b"a\nb\nc");
        assert_eq!(encode("x", true, LineEnding::Lf), b"\xEF\xBB\xBFx");
    }

    #[test]
    fn the_most_common_ending_wins_and_crlf_wins_a_tie() {
        assert_eq!(most_common("a\nb\nc\r\n"), LineEnding::Lf);
        assert_eq!(most_common("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(most_common("a\r\nb\n"), LineEnding::Crlf);
    }

    #[test]
    fn only_note_paths_outside_hidden_and_package_folders_open() {
        for ok in ["Plan.md", "Ideas/Plan.MD", "a/b/c.markdown", "builds/x.md"] {
            assert!(note_path(ok).is_ok(), "{ok}");
        }
        for refused in [
            "Plan.txt",
            ".liurium/project.db",
            ".git/config.md",
            "notes/.hidden.md",
            ".obsidian/x.md",
            "node_modules/pkg/README.md",
            "Docs/Target/x.md",
            "../outside.md",
            "C:/Windows/x.md",
            r"\\server\share\x.md",
            "CON.md",
            "",
        ] {
            assert!(note_path(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn conflict_copies_are_named_next_to_the_note() {
        let path = RelPath::parse("Ideas/Plan.md").expect("path");
        assert_eq!(
            conflict_path(&path, 1).expect("name").to_string(),
            "Ideas/Plan (conflict).md"
        );
        assert_eq!(
            conflict_path(&path, 3).expect("name").to_string(),
            "Ideas/Plan (conflict 3).md"
        );
        let top = RelPath::parse("Read.Me.markdown").expect("path");
        assert_eq!(
            conflict_path(&top, 1).expect("name").to_string(),
            "Read.Me (conflict).markdown"
        );
    }
}
