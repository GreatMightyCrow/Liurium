//! Relative paths from untrusted text: note links, imports, the frontend. Windows
//! name rules are checked here by hand, because the verbatim (`\\?\`) paths that the
//! standard library uses for long paths turn Windows' own name handling off.

use std::fmt;

use super::FsError;

/// The rule a path broke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRule {
    /// Nothing left after removing `.` and empty parts.
    Empty,
    /// Starts at the top of a drive (`\notes`, `/notes`).
    Absolute,
    /// Names a drive (`C:\notes`, `C:notes`).
    Drive,
    /// A network or device path (`\\server\share`, `\\?\`, `\\.\`, `\??\`).
    Device,
    /// A colon, which names an alternate data stream (`note.md:hidden`).
    Stream,
    /// A character Windows does not allow in names.
    Character,
    /// A device name such as `CON` or `NUL`, also with an extension.
    Reserved,
    /// A name ending in a dot or a space, which Windows would silently drop.
    TrailingDotOrSpace,
    /// A name longer than 255 UTF-16 units.
    TooLong,
    /// `..` would leave the project.
    Escapes,
}

/// A path below a project root, checked part by part. Holds no `.`, `..`, or empty
/// parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelPath {
    parts: Vec<String>,
}

const MAX_NAME_UNITS: usize = 255;

impl RelPath {
    /// Accepts `/` and `\` as separators. `..` is resolved here and must not climb
    /// above the root.
    pub fn parse(text: &str) -> Result<Self, FsError> {
        Self::check(text).map_err(FsError::InvalidPath)
    }

    fn check(text: &str) -> Result<Self, PathRule> {
        if text.starts_with(r"\\") || text.starts_with("//") || text.starts_with(r"\??\") {
            return Err(PathRule::Device);
        }
        if text.starts_with(['/', '\\']) {
            return Err(PathRule::Absolute);
        }
        let mut chars = text.chars();
        if let (Some(letter), Some(':')) = (chars.next(), chars.next())
            && letter.is_ascii_alphabetic()
        {
            return Err(PathRule::Drive);
        }
        if text.contains(':') {
            return Err(PathRule::Stream);
        }

        let mut parts: Vec<String> = Vec::new();
        for part in text.split(['/', '\\']) {
            match part {
                "" | "." => {}
                ".." => {
                    if parts.pop().is_none() {
                        return Err(PathRule::Escapes);
                    }
                }
                name => {
                    check_name(name)?;
                    parts.push(name.to_owned());
                }
            }
        }
        if parts.is_empty() {
            return Err(PathRule::Empty);
        }
        Ok(Self { parts })
    }

    pub fn parts(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().map(String::as_str)
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.parts.join("/"))
    }
}

/// Windows file naming rules (learn.microsoft.com, "Naming Files, Paths, and
/// Namespaces"). The colon and the separators are handled before this.
fn check_name(name: &str) -> Result<(), PathRule> {
    if name
        .chars()
        .any(|c| c < ' ' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(PathRule::Character);
    }
    if name.ends_with(['.', ' ']) {
        return Err(PathRule::TrailingDotOrSpace);
    }
    if name.encode_utf16().count() > MAX_NAME_UNITS {
        return Err(PathRule::TooLong);
    }
    if is_reserved(name) {
        return Err(PathRule::Reserved);
    }
    Ok(())
}

/// Device names exist in every folder, in any case, also with an extension
/// (`nul.txt`) or spaces before it (`CON .txt`). Superscript digits count as
/// digits for `COM` and `LPT`.
fn is_reserved(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|rest| {
                let mut digits = rest.chars();
                matches!(
                    (digits.next(), digits.next()),
                    (Some('0'..='9' | '¹' | '²' | '³'), None)
                )
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(text: &str) -> PathRule {
        match RelPath::check(text) {
            Ok(path) => panic!("{text:?} accepted as {path}"),
            Err(rule) => rule,
        }
    }

    fn accepted(text: &str) -> String {
        RelPath::check(text)
            .unwrap_or_else(|rule| panic!("{text:?} refused: {rule:?}"))
            .to_string()
    }

    #[test]
    fn plain_paths_are_accepted_and_normalized() {
        assert_eq!(accepted("notes/idea.md"), "notes/idea.md");
        assert_eq!(accepted(r"notes\idea.md"), "notes/idea.md");
        assert_eq!(accepted("notes/./idea.md"), "notes/idea.md");
        assert_eq!(accepted("notes//idea.md"), "notes/idea.md");
        assert_eq!(accepted("notes/draft/../idea.md"), "notes/idea.md");
        assert_eq!(accepted(".gitignore"), ".gitignore");
        assert_eq!(accepted(" leading space.md"), " leading space.md");
        assert_eq!(accepted("Ünïcödé 名前.md"), "Ünïcödé 名前.md");
    }

    #[test]
    fn names_that_only_look_reserved_are_accepted() {
        for name in [
            "console.md",
            "CONx",
            "COM10",
            "LPT",
            "nul-ish.md",
            "auxiliary",
            "COM1x.md",
        ] {
            accepted(name);
        }
    }

    #[test]
    fn empty_paths_are_refused() {
        for text in ["", ".", "./", "a/..", "a/./.."] {
            assert_eq!(rule(text), PathRule::Empty, "{text:?}");
        }
    }

    #[test]
    fn absolute_drive_and_device_paths_are_refused() {
        assert_eq!(rule("/notes"), PathRule::Absolute);
        assert_eq!(rule(r"\notes"), PathRule::Absolute);
        assert_eq!(rule(r"C:\notes"), PathRule::Drive);
        assert_eq!(rule("c:notes"), PathRule::Drive);
        assert_eq!(rule("C:"), PathRule::Drive);
        for text in [
            r"\\server\share\note.md",
            "//server/share/note.md",
            r"\\?\C:\notes",
            r"\\.\COM1",
            r"\??\C:\notes",
        ] {
            assert_eq!(rule(text), PathRule::Device, "{text:?}");
        }
    }

    #[test]
    fn colons_are_refused_as_streams() {
        assert_eq!(rule("note.md:hidden"), PathRule::Stream);
        assert_eq!(rule("notes/note.md::$DATA"), PathRule::Stream);
        assert_eq!(rule("12:30 meeting.md"), PathRule::Stream);
    }

    #[test]
    fn invalid_characters_are_refused() {
        for text in ["a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\u{1}b", "a\0b"] {
            assert_eq!(rule(text), PathRule::Character, "{text:?}");
        }
    }

    #[test]
    fn reserved_names_are_refused_in_any_form() {
        for text in [
            "CON",
            "con",
            "Prn",
            "AUX",
            "nul.txt",
            "notes/NUL.md",
            "CON .txt",
            "COM1",
            "com0",
            "lpt9.md",
            "COM¹",
            "LPT³.log",
            "CONIN$",
            "conout$.txt",
        ] {
            assert_eq!(rule(text), PathRule::Reserved, "{text:?}");
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_refused() {
        for text in ["note.", "note ", "notes./idea.md", "notes /idea.md", "..."] {
            assert_eq!(rule(text), PathRule::TrailingDotOrSpace, "{text:?}");
        }
    }

    #[test]
    fn names_over_255_units_are_refused() {
        accepted(&"a".repeat(255));
        assert_eq!(rule(&"a".repeat(256)), PathRule::TooLong);
        // 128 characters outside the BMP take two UTF-16 units each.
        assert_eq!(rule(&"😀".repeat(128)), PathRule::TooLong);
    }

    #[test]
    fn climbing_above_the_root_is_refused() {
        for text in ["..", "../x", "a/../..", "a/../../b", r"..\x"] {
            assert_eq!(rule(text), PathRule::Escapes, "{text:?}");
        }
    }
}
