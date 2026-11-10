use std::fs;

use super::task_export::TaskExport;
use super::tests::{added, workspace};
use super::*;
use crate::domain::projects::tasks::{Priority, TaskFields};
use crate::storage::db::Kind;
use crate::test_support::{current, project, read_only, temp_dir};

const NAME: &str = "Tasks export.md";

fn fields(title: &str) -> TaskFields {
    TaskFields {
        title: title.to_owned(),
        description: String::new(),
        priority: Priority::None,
        due: None,
        tags: Vec::new(),
        notes: Vec::new(),
    }
}

fn written() -> Result<TaskExport, CommandError> {
    Ok(TaskExport::Written {
        place: NAME.to_owned(),
    })
}

/// A workspace with one open project holding one task, and the project's folder.
fn opened(dir: &std::path::Path) -> (Workspace, std::path::PathBuf) {
    let garden = project(dir, "Garden", current(Kind::Project));
    let workspace = workspace(&dir.join("app"));
    added(&workspace, &garden.root);
    workspace
        .create_task("todo", fields("First"))
        .expect("task");
    (workspace, garden.root.clone())
}

/// Every file below the project's trash, with its text.
fn trashed(folder: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut waiting = vec![folder.join(".liurium").join("trash")];
    while let Some(next) = waiting.pop() {
        let Ok(entries) = fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                waiting.push(path);
            } else {
                found.push(fs::read_to_string(path).expect("text"));
            }
        }
    }
    found
}

#[test]
fn without_an_open_project_it_says_so() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));

    assert_eq!(workspace.export_tasks(false), Err(CommandError::NoProject));
    assert_eq!(
        workspace.export_tasks_to(&dir.path().join("a.md")),
        Err(CommandError::NoProject)
    );
}

#[test]
fn a_first_export_writes_the_file_in_the_project() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());

    assert_eq!(workspace.export_tasks(false), written());

    let text = fs::read_to_string(folder.join(NAME)).expect("file");
    assert!(text.contains("### First"));
    assert!(trashed(&folder).is_empty());
}

#[test]
fn trashed_tasks_are_left_out() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    let board = workspace
        .create_task("todo", fields("Second"))
        .expect("task");
    workspace
        .trash_task(&board.columns[0].tasks[1].id)
        .expect("trashed");

    workspace.export_tasks(false).expect("written");

    let text = fs::read_to_string(folder.join(NAME)).expect("file");
    assert!(text.contains("### First"));
    assert!(!text.contains("Second"));
}

#[test]
fn an_unchanged_board_writes_nothing_and_asks_nothing() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    workspace.export_tasks(false).expect("written");

    assert_eq!(workspace.export_tasks(false), written());
    assert!(trashed(&folder).is_empty());
}

#[test]
fn a_different_file_is_left_alone_without_the_owners_word() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    fs::write(folder.join(NAME), "my own words").expect("planted");

    assert_eq!(workspace.export_tasks(false), Ok(TaskExport::Exists));

    assert_eq!(
        fs::read_to_string(folder.join(NAME)).expect("file"),
        "my own words"
    );
    assert!(trashed(&folder).is_empty());
}

#[test]
fn a_file_replaced_on_the_owners_word_goes_to_the_trash() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    fs::write(folder.join(NAME), "my own words").expect("planted");

    assert_eq!(workspace.export_tasks(true), written());

    assert!(
        fs::read_to_string(folder.join(NAME))
            .expect("file")
            .contains("### First")
    );
    assert_eq!(trashed(&folder), ["my own words"]);
}

#[test]
fn a_folder_of_that_name_is_refused() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    fs::create_dir(folder.join(NAME)).expect("folder");

    assert_eq!(workspace.export_tasks(true), Err(CommandError::WrongKind));
    assert!(folder.join(NAME).is_dir());
}

#[test]
fn a_write_protected_project_refuses_the_file_inside_it_but_can_export_elsewhere() {
    let dir = temp_dir();
    let archive = project(dir.path(), "Archive", current(Kind::Project));
    read_only(&archive.database());
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &archive.root);
    let outside = dir.path().join("out.md");

    assert_eq!(workspace.export_tasks(false), Err(CommandError::ReadOnly));
    assert_eq!(
        workspace.export_tasks_to(&archive.root.join("in.md")),
        Err(CommandError::ReadOnly)
    );
    assert!(!archive.root.join(NAME).exists());
    assert_eq!(
        workspace.export_tasks_to(&outside),
        Ok(TaskExport::Written {
            place: outside.display().to_string()
        })
    );
    assert!(outside.is_file());
}

#[test]
fn a_chosen_place_gets_the_file_and_replaces_what_the_dialog_asked_about() {
    let dir = temp_dir();
    let (workspace, _) = opened(dir.path());
    let chosen = dir.path().join("Backup.md");
    fs::write(&chosen, "old").expect("planted");

    assert_eq!(
        workspace.export_tasks_to(&chosen),
        Ok(TaskExport::Written {
            place: chosen.display().to_string()
        })
    );

    assert!(
        fs::read_to_string(&chosen)
            .expect("file")
            .contains("### First")
    );
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .expect("folder")
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains("liurium-tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn a_chosen_place_must_be_a_markdown_file() {
    let dir = temp_dir();
    let (workspace, _) = opened(dir.path());

    for name in ["out.txt", "out", "out.db", "out.md.exe"] {
        let path = dir.path().join(name);
        assert_eq!(
            workspace.export_tasks_to(&path),
            Err(CommandError::InvalidPath),
            "for {name}"
        );
        assert!(!path.exists());
    }
    assert!(matches!(
        workspace.export_tasks_to(&dir.path().join("UPPER.MD")),
        Ok(TaskExport::Written { .. })
    ));
}

#[test]
fn liuriums_own_folders_are_refused_as_a_chosen_place() {
    let dir = temp_dir();
    let (workspace, folder) = opened(dir.path());
    fs::create_dir(folder.join(".git")).expect("git");

    for path in [
        folder.join(".liurium").join("out.md"),
        folder.join(".LIURIUM").join("out.md"),
        folder.join(".git").join("out.md"),
    ] {
        assert_eq!(
            workspace.export_tasks_to(&path),
            Err(CommandError::Protected),
            "for {}",
            path.display()
        );
        assert!(!path.exists());
    }
}

#[test]
fn a_folder_at_a_chosen_place_is_refused() {
    let dir = temp_dir();
    let (workspace, _) = opened(dir.path());
    let chosen = dir.path().join("Folder.md");
    fs::create_dir(&chosen).expect("folder");

    assert_eq!(
        workspace.export_tasks_to(&chosen),
        Err(CommandError::WrongKind)
    );
    assert!(chosen.is_dir());
}

#[test]
fn a_read_only_file_at_a_chosen_place_is_refused() {
    let dir = temp_dir();
    let (workspace, _) = opened(dir.path());
    let chosen = dir.path().join("Locked.md");
    fs::write(&chosen, "old").expect("planted");
    let mut permissions = fs::metadata(&chosen).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&chosen, permissions).expect("locked");

    assert_eq!(
        workspace.export_tasks_to(&chosen),
        Err(CommandError::ReadOnly)
    );
    assert_eq!(fs::read_to_string(&chosen).expect("file"), "old");
}
