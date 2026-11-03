use std::fs;

use super::*;
use crate::test_support::{junction, temp_dir};

fn onedrive(folder: &Path) -> SyncRoot {
    SyncRoot {
        tool: SyncTool::OneDrive,
        folder: folder.to_owned(),
    }
}

#[test]
fn onedrive_folders_come_from_its_environment_variables() {
    let roots = onedrive_from_env(|name| match name {
        "OneDrive" | "OneDriveConsumer" => Some(r"C:\Users\Ada\OneDrive".into()),
        "OneDriveCommercial" => Some(r"C:\Users\Ada\OneDrive - Firm".into()),
        _ => None,
    });
    assert_eq!(
        roots,
        [
            r"C:\Users\Ada\OneDrive",
            r"C:\Users\Ada\OneDrive",
            r"C:\Users\Ada\OneDrive - Firm"
        ]
        .map(|folder| onedrive(Path::new(folder)))
    );
}

#[test]
fn empty_or_relative_folders_are_ignored() {
    let roots = onedrive_from_env(|name| match name {
        "OneDrive" => Some("".into()),
        "OneDriveConsumer" => Some(r"OneDrive".into()),
        _ => Some(r"\OneDrive".into()),
    });
    assert_eq!(roots, []);
    let info = r#"{"personal": {"path": ""}, "business": {"path": "Dropbox"}}"#;
    assert_eq!(dropbox_from_info(info), []);
}

#[test]
fn dropbox_folders_come_from_its_info_file() {
    let info = r#"{
        "personal": {"path": "C:\\Users\\Ada\\Dropbox", "host": 1, "is_team": false},
        "business": {"path": "C:\\Users\\Ada\\Dropbox (Firm)", "host": 1, "is_team": true}
    }"#;
    let folders: Vec<_> = dropbox_from_info(info)
        .into_iter()
        .map(|root| (root.tool, root.folder))
        .collect();
    assert_eq!(
        folders,
        [
            (
                SyncTool::Dropbox,
                PathBuf::from(r"C:\Users\Ada\Dropbox (Firm)")
            ),
            (SyncTool::Dropbox, PathBuf::from(r"C:\Users\Ada\Dropbox")),
        ]
    );
}

#[test]
fn an_unexpected_info_file_adds_nothing() {
    for text in [
        "",
        "not json",
        "[]",
        r#"{"personal": "C:\\Dropbox"}"#,
        r#"{"personal": {"path": 7}}"#,
        r#"{"personal": {"folder": "C:\\Dropbox"}}"#,
    ] {
        assert_eq!(dropbox_from_info(text), [], "{text}");
    }
}

#[test]
fn a_large_info_file_is_not_read() {
    let dir = temp_dir();
    let small = dir.path().join("small.json");
    let large = dir.path().join("large.json");
    fs::write(&small, "{}").expect("file");
    let limit = usize::try_from(MAX_INFO_LEN).expect("small limit");
    fs::write(&large, " ".repeat(limit + 1)).expect("file");
    assert_eq!(read_small(&small).as_deref(), Some("{}"));
    assert_eq!(read_small(&large), None);
    assert_eq!(read_small(&dir.path().join("missing.json")), None);
}

#[test]
fn a_folder_inside_a_root_or_the_root_itself_is_synced() {
    let dir = temp_dir();
    let root = dir.path().join("OneDrive");
    let project = root.join("Documents").join("notes");
    fs::create_dir_all(&project).expect("folders");
    let roots = [onedrive(&root)];
    assert_eq!(tool_for(&project, &roots), Some(SyncTool::OneDrive));
    assert_eq!(tool_for(&root, &roots), Some(SyncTool::OneDrive));
}

#[test]
fn case_and_spelling_do_not_matter() {
    let dir = temp_dir();
    let root = dir.path().join("OneDrive");
    let project = root.join("notes");
    fs::create_dir_all(&project).expect("folders");
    let spelled = dir.path().join("ONEDRIVE").join(".").join("Notes");
    assert_eq!(
        tool_for(&spelled, &[onedrive(&root)]),
        Some(SyncTool::OneDrive)
    );
}

#[test]
fn a_sibling_with_a_longer_name_is_not_synced() {
    let dir = temp_dir();
    let root = dir.path().join("Dropbox");
    let sibling = dir.path().join("Dropbox (old)");
    fs::create_dir_all(&root).expect("root");
    fs::create_dir_all(&sibling).expect("sibling");
    let roots = [SyncRoot {
        tool: SyncTool::Dropbox,
        folder: root,
    }];
    assert_eq!(tool_for(&sibling, &roots), None);
    assert_eq!(tool_for(dir.path(), &roots), None);
}

#[test]
fn a_root_that_does_not_exist_matches_nothing() {
    let dir = temp_dir();
    let roots = [onedrive(&dir.path().join("OneDrive"))];
    assert_eq!(tool_for(dir.path(), &roots), None);
}

#[test]
fn a_project_reached_through_a_junction_into_a_root_is_synced() {
    let dir = temp_dir();
    let root = dir.path().join("OneDrive");
    let target = root.join("notes");
    fs::create_dir_all(&target).expect("folders");
    let link = dir.path().join("notes");
    junction(&link, &target);
    assert_eq!(
        tool_for(&link, &[onedrive(&root)]),
        Some(SyncTool::OneDrive)
    );
}

#[test]
fn the_real_sources_give_each_absolute_folder_once() {
    let roots = detect();
    assert!(
        roots.iter().all(|root| root.folder.is_absolute()),
        "{roots:?}"
    );
    for (index, root) in roots.iter().enumerate() {
        assert!(!roots[..index].contains(root), "{roots:?}");
    }
}
