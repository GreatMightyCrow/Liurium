use std::fs;

use super::tests::{added, workspace};
use super::*;
use crate::domain::projects::tasks::{Priority, TaskFields};
use crate::storage::db::Kind;
use crate::test_support::{current, project, read_only, temp_dir};

fn fields(title: &str, notes: &[&str]) -> TaskFields {
    TaskFields {
        title: title.to_owned(),
        description: String::new(),
        priority: Priority::None,
        due: None,
        tags: Vec::new(),
        notes: notes.iter().map(ToString::to_string).collect(),
    }
}

#[test]
fn without_an_open_project_tasks_report_no_project() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));

    assert_eq!(workspace.task_board(), Err(CommandError::NoProject));
    assert_eq!(
        workspace.tasks_with_description("x"),
        Err(CommandError::NoProject)
    );
    assert_eq!(
        workspace.create_task("todo", fields("T", &[])),
        Err(CommandError::NoProject)
    );
}

#[test]
fn a_write_protected_project_refuses_every_change_and_still_shows_its_board() {
    let dir = temp_dir();
    let archive = project(dir.path(), "Archive", current(Kind::Project));
    read_only(&archive.database());
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &archive.root);

    assert_eq!(workspace.task_board().expect("board").columns.len(), 3);
    assert_eq!(workspace.tasks_with_description("x"), Ok(Vec::new()));
    let refused = [
        workspace.create_task("todo", fields("T", &[])),
        workspace.update_task("t", fields("T", &[])),
        workspace.move_task("t", "todo", 0),
        workspace.trash_task("t"),
        workspace.restore_task("t"),
        workspace.create_column("C"),
        workspace.rename_column("todo", "C"),
        workspace.move_column("todo", 0),
        workspace.delete_column("todo"),
    ];
    for result in refused {
        assert_eq!(result, Err(CommandError::ReadOnly));
    }
    assert_eq!(workspace.delete_task("t"), Err(CommandError::ReadOnly));
}

#[test]
fn task_errors_reach_the_page_as_their_own_kinds() {
    let dir = temp_dir();
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &garden.root);

    assert_eq!(
        workspace.create_task("todo", fields("", &[])),
        Err(CommandError::InvalidTask)
    );
    assert_eq!(
        workspace.create_task("nope", fields("T", &[])),
        Err(CommandError::NotFound)
    );
    assert_eq!(
        workspace.create_task("todo", fields("T", &["Gone.md"])),
        Err(CommandError::NotFound)
    );
    assert_eq!(
        workspace.create_task("todo", fields("T", &["../Out.md"])),
        Err(CommandError::InvalidPath)
    );
    assert_eq!(workspace.create_column(""), Err(CommandError::InvalidName));

    workspace
        .create_task("todo", fields("Held", &[]))
        .expect("created");
    assert_eq!(
        workspace.delete_column("todo"),
        Err(CommandError::ColumnInUse)
    );
}

#[test]
fn a_rename_or_move_in_liurium_takes_the_links_along() {
    let dir = temp_dir();
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    fs::create_dir(garden.root.join("Ideas")).expect("folder");
    fs::create_dir(garden.root.join("Done")).expect("folder");
    fs::write(garden.root.join("Ideas/Plan.md"), "x").expect("note");
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &garden.root);

    let board = workspace
        .create_task("todo", fields("T", &["Ideas/Plan.md"]))
        .expect("linked");
    let task = board.columns[0].tasks[0].id.clone();
    let links = || workspace.task_detail(&task).expect("detail").task.notes;

    workspace
        .rename_entry("Ideas/Plan.md", "Goal")
        .expect("renamed");
    assert_eq!(links(), ["Ideas/Goal.md"]);

    workspace
        .move_entry("Ideas/Goal.md", "Done")
        .expect("moved");
    assert_eq!(links(), ["Done/Goal.md"]);

    workspace
        .rename_entry("Done", "Finished")
        .expect("folder renamed");
    assert_eq!(links(), ["Finished/Goal.md"]);

    // Trashing a note keeps the link, which then shows as missing.
    workspace.trash_entry("Finished/Goal.md").expect("trashed");
    assert_eq!(links(), ["Finished/Goal.md"]);
}
