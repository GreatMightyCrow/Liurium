//! Names and paths from the page for creating, renaming, and moving (M3-004). The
//! same rules as the walk: nothing starting with `.`, no skipped package folder, so
//! a new item never disappears from the tree; notes end in `.md` or `.markdown`.

use crate::storage::fs::{FsError, NOTE_ENDINGS, PathRule, RelPath, SKIPPED_FOLDERS};

fn hidden_or_skipped(part: &str) -> bool {
    part.starts_with('.') || SKIPPED_FOLDERS.contains(&part.to_lowercase().as_str())
}

pub fn is_note_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    NOTE_ENDINGS.iter().any(|ending| lower.ends_with(ending))
}

/// A folder of the tree; the empty text is the top of the project.
pub fn folder_path(text: &str) -> Result<Option<RelPath>, FsError> {
    if text.is_empty() {
        return Ok(None);
    }
    let path = RelPath::parse(text)?;
    if path.parts().any(hidden_or_skipped) {
        return Err(FsError::InvalidPath(PathRule::Skipped));
    }
    Ok(Some(path))
}

/// An existing note or folder of the tree.
pub fn entry_path(text: &str) -> Result<RelPath, FsError> {
    folder_path(text)?.ok_or(FsError::InvalidPath(PathRule::Empty))
}

/// A name typed for a note: `Idea` becomes `Idea.md`.
pub fn note_name(text: &str) -> Result<String, FsError> {
    let name = text.trim();
    let name = if is_note_name(name) {
        name.to_owned()
    } else {
        format!("{name}.md")
    };
    // An empty name becomes `.md`, which the hidden-name rule refuses.
    checked_name(&name)?;
    Ok(name)
}

/// A name typed for a folder.
pub fn folder_name(text: &str) -> Result<String, FsError> {
    let name = text.trim().to_owned();
    checked_name(&name)?;
    Ok(name)
}

fn checked_name(name: &str) -> Result<(), FsError> {
    RelPath::name(name)?;
    if hidden_or_skipped(name) {
        return Err(FsError::InvalidPath(PathRule::Skipped));
    }
    Ok(())
}

/// `name` inside `folder` (or at the top).
pub fn join(folder: Option<&RelPath>, name: &str) -> Result<RelPath, FsError> {
    match folder {
        Some(folder) => folder.child(name),
        None => RelPath::name(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_get_md_when_they_have_no_note_ending() {
        assert_eq!(note_name("Idea").expect("name"), "Idea.md");
        assert_eq!(note_name("  Plan.MD ").expect("name"), "Plan.MD");
        assert_eq!(
            note_name("Read.Me.markdown").expect("name"),
            "Read.Me.markdown"
        );
        assert_eq!(note_name("notes.txt").expect("name"), "notes.txt.md");
        for refused in ["", "   ", ".md", ".hidden", "a/b", "CON", "x?"] {
            assert!(note_name(refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn folder_names_follow_the_walk_rules() {
        assert_eq!(folder_name(" Ideas ").expect("name"), "Ideas");
        for refused in [
            "",
            ".obsidian",
            "node_modules",
            "Build",
            "a/b",
            "..",
            "trail.",
        ] {
            assert!(folder_name(refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn tree_paths_leave_out_hidden_and_package_folders() {
        assert_eq!(folder_path("").expect("top"), None);
        assert_eq!(
            folder_path("Ideas/Deep")
                .expect("path")
                .map(|p| p.to_string()),
            Some("Ideas/Deep".to_owned())
        );
        for refused in [".liurium", "a/.git", "node_modules/x", "../up", "C:/x"] {
            assert!(folder_path(refused).is_err(), "{refused:?}");
        }
        assert!(entry_path("").is_err());
    }
}
