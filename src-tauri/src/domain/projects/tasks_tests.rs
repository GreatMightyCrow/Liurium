use std::fs;

use rusqlite::params;

use super::tasks::{Board, Priority, TaskError, TaskFields};
use super::*;
use crate::storage::db;
use crate::storage::fs::FsError;
use crate::test_support::{Snapshot, current, project as fixture, read_only, temp_dir};

fn app(dir: &Path) -> Connection {
    db::open_app(&dir.join("app"))
        .expect("app database")
        .connection
}

fn fresh(dir: &Path, app: &Connection) -> Project {
    let folder = dir.join("Work");
    fs::create_dir(&folder).expect("folder");
    add(app, &folder).expect("added")
}

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

/// Column names with the titles in them, in order.
fn shown(board: &Board) -> Vec<(String, Vec<String>)> {
    board
        .columns
        .iter()
        .map(|column| {
            (
                column.name.clone(),
                column.tasks.iter().map(|task| task.title.clone()).collect(),
            )
        })
        .collect()
}

fn titles(project: &Project, column: usize) -> Vec<String> {
    project.task_board().expect("board").columns[column]
        .tasks
        .iter()
        .map(|task| task.title.clone())
        .collect()
}

fn id_of(project: &Project, title: &str) -> String {
    project
        .task_board()
        .expect("board")
        .columns
        .iter()
        .flat_map(|column| &column.tasks)
        .find(|task| task.title == title)
        .expect("task")
        .id
        .clone()
}

fn add_tasks(project: &Project, column: &str, names: &[&str]) {
    for name in names {
        project.create_task(column, fields(name)).expect("created");
    }
}

fn is_invalid<T: std::fmt::Debug>(result: Result<T, TaskError>) -> bool {
    matches!(result, Err(TaskError::Invalid))
}

fn described(title: &str, description: &str) -> TaskFields {
    TaskFields {
        description: description.to_owned(),
        ..fields(title)
    }
}

#[test]
fn a_description_is_found_in_any_case_also_beyond_ascii() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .create_task("todo", described("A", "Viel ÄRGER mit dem Dach"))
        .expect("created");
    project
        .create_task("doing", described("B", "Nothing of the kind"))
        .expect("created");
    project
        .create_task("todo", fields("Ärger"))
        .expect("created");

    assert_eq!(
        project.tasks_with_description("  ärger ").expect("found"),
        vec![id_of(&project, "A")]
    );
    assert_eq!(
        project.tasks_with_description("äRgEr").expect("found"),
        vec![id_of(&project, "A")]
    );
}

#[test]
fn a_filter_finds_nothing_in_the_trash_or_for_blank_text() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .create_task("todo", described("A", "needle"))
        .expect("created");
    project
        .create_task("todo", described("B", "needle"))
        .expect("created");
    project.trash_task(&id_of(&project, "B")).expect("trashed");

    assert_eq!(
        project.tasks_with_description("needle").expect("found"),
        vec![id_of(&project, "A")]
    );
    assert!(
        project
            .tasks_with_description("   ")
            .expect("none")
            .is_empty()
    );
}

#[test]
fn text_too_long_for_a_filter_is_refused() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);

    assert!(
        project
            .tasks_with_description(&"ä".repeat(200))
            .expect("fits")
            .is_empty()
    );
    assert!(is_invalid(project.tasks_with_description(&"ä".repeat(201))));
}

#[test]
fn the_export_reads_only_descriptions_on_the_board_and_within_its_limit() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .create_task("todo", described("A", "abcd"))
        .expect("created");
    project
        .create_task("todo", described("B", "efgh"))
        .expect("created");
    project.trash_task(&id_of(&project, "B")).expect("trashed");

    let found = project.live_descriptions(4).expect("fits");
    assert_eq!(found.len(), 1);
    assert_eq!(found[&id_of(&project, "A")], "abcd");
    assert!(matches!(
        project.live_descriptions(3),
        Err(TaskError::Limit)
    ));
}

#[test]
fn a_description_that_is_not_utf8_does_not_stop_the_filter() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .create_task("todo", described("A", "x"))
        .expect("created");
    project
        .create_task("todo", described("B", "needle"))
        .expect("created");
    let bad = id_of(&project, "A");
    project
        .connection
        .execute(
            "UPDATE tasks SET description = CAST(X'41FF42' AS TEXT) WHERE id = ?1",
            [&bad],
        )
        .expect("planted");

    assert_eq!(
        project.tasks_with_description("needle").expect("found"),
        vec![id_of(&project, "B")]
    );
}

#[test]
fn a_new_project_starts_with_three_empty_columns() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);

    assert_eq!(
        shown(&project.task_board().expect("board")),
        [
            ("To do".to_owned(), vec![]),
            ("Doing".to_owned(), vec![]),
            ("Done".to_owned(), vec![]),
        ]
    );
}

#[test]
fn a_task_keeps_all_its_fields_and_only_its_detail_holds_the_text() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    fs::write(project.root.path().join("Plan.md"), "x").expect("note");

    let board = project
        .create_task(
            "todo",
            TaskFields {
                title: "  Water the beds  ".to_owned(),
                description: "First line\n\twith a [[Plan]]".to_owned(),
                priority: Priority::High,
                due: Some("2028-02-29".to_owned()),
                tags: vec!["garden/beds".to_owned(), "Garden".to_owned()],
                notes: vec!["Plan.md".to_owned()],
            },
        )
        .expect("created");

    let task = &board.columns[0].tasks[0];
    assert_eq!(task.title, "Water the beds");
    assert!(task.has_description);
    assert_eq!(task.priority, Priority::High);
    assert_eq!(task.due.as_deref(), Some("2028-02-29"));
    assert_eq!(task.tags, ["Garden", "garden/beds"]);
    assert_eq!(task.notes, ["Plan.md"]);
    assert_eq!(task.trashed_ms, None);

    let detail = project.task_detail(&task.id).expect("detail");
    assert_eq!(detail.description, "First line\n\twith a [[Plan]]");
    assert_eq!(detail.column, "todo");
    assert_eq!(&detail.task, task);

    project
        .update_task(
            &task.id,
            TaskFields {
                priority: Priority::Low,
                ..fields("Water")
            },
        )
        .expect("updated");
    let changed = project.task_detail(&task.id).expect("detail");
    assert_eq!(changed.task.title, "Water");
    assert_eq!(changed.task.priority, Priority::Low);
    assert_eq!(changed.task.due, None);
    assert!(changed.task.tags.is_empty(), "tags are replaced");
    assert!(changed.task.notes.is_empty(), "links are replaced");
    assert!(!changed.task.has_description);
}

#[test]
fn tasks_survive_a_restart_and_a_moved_project_folder() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["One", "Two"]);
    let id = project.id.clone();
    let folder = project.root.path().to_owned();
    drop(project);

    let again = open(&app, &id).expect("opened again");
    assert_eq!(titles(&again, 0), ["One", "Two"]);
    drop(again);

    let moved = dir.path().join("Elsewhere");
    fs::rename(&folder, &moved).expect("moved");
    let found = add(&app, &moved).expect("found at the new place");
    assert_eq!(found.id, id);
    assert_eq!(titles(&found, 0), ["One", "Two"]);
}

#[test]
fn a_new_task_goes_to_the_bottom_and_moves_keep_the_order() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["A", "B", "C"]);
    assert_eq!(titles(&project, 0), ["A", "B", "C"]);

    // Inside a column, counted without the moved task.
    project
        .move_task(&id_of(&project, "C"), "todo", 0)
        .expect("up");
    assert_eq!(titles(&project, 0), ["C", "A", "B"]);
    project
        .move_task(&id_of(&project, "C"), "todo", 1)
        .expect("down");
    assert_eq!(titles(&project, 0), ["A", "C", "B"]);

    // To another column; past the end is the end.
    project
        .move_task(&id_of(&project, "A"), "doing", 99)
        .expect("over");
    add_tasks(&project, "doing", &["D"]);
    project
        .move_task(&id_of(&project, "B"), "doing", 1)
        .expect("between");
    assert_eq!(titles(&project, 0), ["C"]);
    assert_eq!(titles(&project, 1), ["A", "B", "D"]);
}

#[test]
fn thousands_of_moves_leave_the_exact_order() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    let names = ["A", "B", "C", "D", "E"];
    add_tasks(&project, "todo", &names);
    let mut expected: Vec<String> = names.iter().map(ToString::to_string).collect();

    for round in 0..2000_usize {
        let from = (round * 7) % expected.len();
        let to = (round * 3) % expected.len();
        let name = expected.remove(from);
        project
            .move_task(
                &id_of(&project, &name),
                "todo",
                u32::try_from(to).expect("small"),
            )
            .expect("moved");
        expected.insert(to, name);
        assert_eq!(titles(&project, 0), expected, "after move {round}");
    }

    let highest: i64 = project
        .connection
        .query_row("SELECT max(position) FROM tasks", [], |row| row.get(0))
        .expect("positions");
    assert_eq!(highest, 4, "the numbers stay small");
}

#[test]
fn equal_positions_in_a_foreign_file_sort_by_creation_then_id() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["B", "A", "C"]);
    project
        .connection
        .execute_batch(
            "UPDATE tasks SET position = 5, created_ms = 9;
             UPDATE tasks SET id = 'b' WHERE title = 'B';
             UPDATE tasks SET id = 'a' WHERE title = 'A';
             UPDATE tasks SET created_ms = 1 WHERE title = 'C';",
        )
        .expect("changed by hand");

    assert_eq!(titles(&project, 0), ["C", "A", "B"]);
}

#[test]
fn the_trash_keeps_a_task_until_it_is_deleted_from_there() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    fs::write(project.root.path().join("Plan.md"), "x").expect("note");
    add_tasks(&project, "todo", &["A", "B"]);
    let a = id_of(&project, "A");

    project
        .update_task(
            &a,
            TaskFields {
                tags: vec!["kept".to_owned()],
                notes: vec!["Plan.md".to_owned()],
                ..fields("A")
            },
        )
        .expect("labelled");

    // A live task cannot be deleted for good.
    assert!(matches!(project.delete_task(&a), Err(TaskError::NotFound)));

    project.trash_task(&a).expect("trashed");
    assert_eq!(titles(&project, 0), ["B"]);
    let trash = project.trashed_tasks().expect("trash");
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].title, "A");
    assert!(trash[0].trashed_ms.is_some());
    assert_eq!(trash[0].tags, ["kept"]);

    // In the trash it cannot be edited, moved, or trashed again.
    assert!(matches!(
        project.update_task(&a, fields("X")),
        Err(TaskError::NotFound)
    ));
    assert!(matches!(
        project.move_task(&a, "todo", 0),
        Err(TaskError::NotFound)
    ));
    assert!(matches!(project.trash_task(&a), Err(TaskError::NotFound)));

    // Back at the bottom, with what it had.
    project.restore_task(&a).expect("restored");
    assert_eq!(titles(&project, 0), ["B", "A"]);
    assert!(project.trashed_tasks().expect("trash").is_empty());
    assert!(matches!(project.restore_task(&a), Err(TaskError::NotFound)));
    assert_eq!(project.task_detail(&a).expect("detail").task.tags, ["kept"]);

    project.trash_task(&a).expect("trashed again");
    project.delete_task(&a).expect("deleted");
    assert!(project.trashed_tasks().expect("trash").is_empty());
    assert!(matches!(project.task_detail(&a), Err(TaskError::NotFound)));
    for table in ["task_tags", "task_notes"] {
        let left: i64 = project
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(left, 0, "{table} goes with its task");
    }
}

#[test]
fn columns_are_the_projects_own() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);

    let board = project.create_column("  Review ").expect("created");
    let review = board.columns[3].id.clone();
    assert_eq!(board.columns[3].name, "Review");

    project.rename_column("todo", "Ideas").expect("renamed");
    let board = project.move_column(&review, 1).expect("moved");
    let names: Vec<_> = board
        .columns
        .iter()
        .map(|each| each.name.as_str())
        .collect();
    assert_eq!(names, ["Ideas", "Review", "Doing", "Done"]);

    for name in ["", "   ", "two\nlines", &"x".repeat(201)] {
        assert!(matches!(
            project.create_column(name),
            Err(TaskError::InvalidColumnName)
        ));
        assert!(matches!(
            project.rename_column("todo", name),
            Err(TaskError::InvalidColumnName)
        ));
    }
    assert!(matches!(
        project.rename_column("nope", "X"),
        Err(TaskError::NotFound)
    ));
    assert!(matches!(
        project.move_column("nope", 0),
        Err(TaskError::NotFound)
    ));
    assert!(matches!(
        project.create_task("nope", fields("X")),
        Err(TaskError::NotFound)
    ));
}

#[test]
fn a_column_goes_only_when_empty_and_its_trash_stays_restorable() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "doing", &["Live", "Binned"]);

    assert!(matches!(
        project.delete_column("doing"),
        Err(TaskError::ColumnInUse)
    ));
    assert_eq!(titles(&project, 1), ["Live", "Binned"], "nothing changed");

    project
        .move_task(&id_of(&project, "Live"), "todo", 0)
        .expect("out");
    let binned = id_of(&project, "Binned");
    project.trash_task(&binned).expect("trashed");

    let board = project.delete_column("doing").expect("deleted");
    assert_eq!(board.columns.len(), 2);

    project.restore_task(&binned).expect("restored");
    assert_eq!(titles(&project, 0), ["Live", "Binned"]);

    project
        .move_task(&id_of(&project, "Live"), "done", 0)
        .expect("out");
    project.move_task(&binned, "done", 0).expect("out");
    project.delete_column("todo").expect("deleted");
    assert!(matches!(
        project.delete_task("nope"),
        Err(TaskError::NotFound)
    ));
    project.move_task(&binned, "done", 5).expect("stays");
    project.trash_task(&binned).expect("binned");
    project
        .trash_task(&id_of(&project, "Live"))
        .expect("binned");
    assert!(
        matches!(project.delete_column("done"), Err(TaskError::ColumnInUse)),
        "the last column stays"
    );
}

#[test]
fn input_outside_the_rules_is_refused_and_changes_nothing() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["Kept"]);
    let kept = id_of(&project, "Kept");

    for title in ["", "   ", "two\nlines", "a\u{7}b", &"x".repeat(501)] {
        assert!(
            is_invalid(project.create_task("todo", fields(title))),
            "{title:?}"
        );
        assert!(
            is_invalid(project.update_task(&kept, fields(title))),
            "{title:?}"
        );
    }
    assert!(!is_invalid(
        project.create_task("todo", fields(&"é".repeat(500)))
    ));

    for description in [
        "a\u{0}b".to_owned(),
        "esc\u{1b}[0m".to_owned(),
        "x".repeat(1_048_577),
    ] {
        let task = TaskFields {
            description,
            ..fields("T")
        };
        assert!(is_invalid(project.create_task("todo", task)));
    }
    let task = TaskFields {
        description: format!("line\r\n\tnext{}", "x".repeat(1000)),
        ..fields("Fine")
    };
    project
        .create_task("todo", task)
        .expect("line breaks and tabs are text");

    for due in [
        "2027-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-04-31",
        "0000-01-01",
        "2026-1-1",
        "tomorrow",
        "+026-01-01",
        "2026/01/01",
    ] {
        let task = TaskFields {
            due: Some(due.to_owned()),
            ..fields("T")
        };
        assert!(is_invalid(project.create_task("todo", task)), "{due}");
    }

    for tag in ["", "two words", "/x", "2026", &"x".repeat(101)] {
        let task = TaskFields {
            tags: vec![tag.to_owned()],
            ..fields("T")
        };
        assert!(
            matches!(
                project.create_task("todo", task),
                Err(TaskError::InvalidTag)
            ),
            "{tag:?}"
        );
    }
    let many = TaskFields {
        tags: (0..51).map(|n| format!("t{n}")).collect(),
        ..fields("T")
    };
    assert!(matches!(
        project.create_task("todo", many),
        Err(TaskError::Limit)
    ));
    let same = TaskFields {
        tags: vec!["Same".to_owned(), "same".to_owned()],
        ..fields("Same")
    };
    let board = project.create_task("todo", same).expect("one tag");
    let created = board.columns[0].tasks.last().expect("task");
    assert_eq!(created.tags, ["Same"]);

    assert_eq!(titles(&project, 0)[0], "Kept");
    for id in ["", "' OR 1=1 --", "nope"] {
        assert!(matches!(project.task_detail(id), Err(TaskError::NotFound)));
        assert!(matches!(project.trash_task(id), Err(TaskError::NotFound)));
    }
}

#[test]
fn a_full_project_refuses_more_tasks_and_columns() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .connection
        .execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
             INSERT INTO tasks (id, column_id, position, title, created_ms, updated_ms)
             SELECT 'id' || i, 'todo', i, 'T' || i, 0, 0 FROM n;",
        )
        .expect("many tasks");
    assert!(matches!(
        project.create_task("todo", fields("One more")),
        Err(TaskError::Limit)
    ));
    assert_eq!(titles(&project, 0).len(), 10_000);

    for n in 3..100 {
        project.create_column(&format!("C{n}")).expect("column");
    }
    assert!(matches!(
        project.create_column("One more"),
        Err(TaskError::Limit)
    ));

    // A foreign file can hold more; a board still stays bounded.
    project
        .connection
        .execute_batch(
            "INSERT INTO tasks (id, column_id, position, title, created_ms, updated_ms)
             VALUES ('extra', 'todo', 99999, 'Extra', 0, 0);
             INSERT INTO task_columns (id, name, position) VALUES ('extra', 'Extra', 999);",
        )
        .expect("over the limit");
    let board = project.task_board().expect("board");
    assert_eq!(board.columns.len(), 100);
    assert_eq!(board.columns[0].tasks.len(), 10_000);
}

#[test]
fn a_task_holds_at_most_its_links_and_a_foreign_file_cannot_show_more() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    let root = project.root.path().to_owned();
    for n in 0..101 {
        fs::write(root.join(format!("N{n}.md")), "x").expect("note");
    }
    let names: Vec<String> = (0..101).map(|n| format!("N{n}.md")).collect();
    let too_many = TaskFields {
        notes: names.clone(),
        ..fields("T")
    };
    assert!(matches!(
        project.create_task("todo", too_many),
        Err(TaskError::Limit)
    ));
    let board = project
        .create_task(
            "todo",
            TaskFields {
                notes: names[..100].to_vec(),
                ..fields("T")
            },
        )
        .expect("100 links fit");
    let id = board.columns[0].tasks[0].id.clone();

    project
        .connection
        .execute_batch(&format!(
            "INSERT INTO task_notes VALUES ('{id}', 'Extra.md');
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
             INSERT INTO task_tags SELECT '{id}', 'tag' || i FROM n;"
        ))
        .expect("over the limit");
    let task = &project.task_board().expect("board").columns[0].tasks[0];
    assert_eq!(task.notes.len(), 100);
    assert_eq!(task.tags.len(), 50);
}

#[test]
fn only_a_change_of_column_counts_as_an_update() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["A", "B"]);
    project
        .connection
        .execute("UPDATE tasks SET updated_ms = 5", [])
        .expect("old time");
    let updated = |project: &Project, title: &str| {
        let id = id_of(project, title);
        project.task_detail(&id).expect("detail").task.updated_ms
    };

    project
        .move_task(&id_of(&project, "B"), "todo", 0)
        .expect("reordered");
    assert_eq!(updated(&project, "B"), 5);

    project
        .move_task(&id_of(&project, "B"), "doing", 0)
        .expect("moved");
    assert!(updated(&project, "B") > 5);
    assert_eq!(updated(&project, "A"), 5);
}

#[test]
fn a_trashed_task_of_a_column_gone_by_hand_comes_back_in_the_first_column() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "doing", &["A"]);
    let a = id_of(&project, "A");
    project.trash_task(&a).expect("trashed");
    project
        .connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             DELETE FROM task_columns WHERE id = 'doing';
             PRAGMA foreign_keys = ON;",
        )
        .expect("changed by hand");

    project.restore_task(&a).expect("restored");

    assert_eq!(titles(&project, 0), ["A"]);
    assert_eq!(project.task_detail(&a).expect("detail").column, "todo");
}

#[test]
fn an_oversized_text_in_a_foreign_file_is_cut_when_read() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "todo", &["A"]);
    let a = id_of(&project, "A");
    project
        .connection
        .execute(
            "UPDATE tasks SET description = ?1",
            params!["x".repeat(1_048_600)],
        )
        .expect("long text");

    assert_eq!(
        project.task_detail(&a).expect("detail").description.len(),
        1_048_576
    );
}

#[test]
fn a_note_link_must_be_a_note_of_the_tree_when_it_is_made() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    let root = project.root.path().to_owned();
    fs::create_dir(root.join("Ideas")).expect("folder");
    fs::write(root.join("Ideas/Plan.md"), "x").expect("note");
    fs::write(root.join("code.rs"), "x").expect("file");

    let with = |path: &str| TaskFields {
        notes: vec![path.to_owned()],
        ..fields("T")
    };
    for path in [
        "Gone.md",
        "code.rs",
        "Ideas",
        "../Outside.md",
        ".liurium/project.db",
        "",
    ] {
        assert!(project.create_task("todo", with(path)).is_err(), "{path}");
    }
    assert!(matches!(
        project.create_task("todo", with("Gone.md")),
        Err(TaskError::Project(ProjectError::Fs(FsError::NotFound)))
    ));

    let board = project
        .create_task("todo", with("Ideas/Plan.md"))
        .expect("linked");
    let task = board.columns[0].tasks[0].id.clone();

    // A note gone since stays linked when the task changes otherwise.
    fs::remove_file(root.join("Ideas/Plan.md")).expect("gone");
    project
        .update_task(
            &task,
            TaskFields {
                priority: Priority::High,
                ..with("Ideas/Plan.md")
            },
        )
        .expect("a known link stays");
    assert_eq!(
        project.task_detail(&task).expect("detail").task.notes,
        ["Ideas/Plan.md"]
    );

    let many = TaskFields {
        notes: (0..101).map(|_| "Ideas/Plan.md".to_owned()).collect(),
        ..fields("T")
    };
    assert_eq!(
        project
            .update_task(&task, many)
            .expect("the same note counts once")
            .columns[0]
            .tasks[0]
            .notes,
        ["Ideas/Plan.md"]
    );
}

#[test]
fn links_follow_a_note_or_folder_and_no_other() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    let root = project.root.path().to_owned();
    fs::create_dir_all(root.join("Plans-old")).expect("folder");
    fs::create_dir_all(root.join("Plans/Sub")).expect("folder");
    for note in ["Top.md", "Plans/A.md", "Plans/Sub/B.md", "Plans-old/C.md"] {
        fs::write(root.join(note), "x").expect("note");
    }
    let board = project
        .create_task(
            "todo",
            TaskFields {
                notes: ["Top.md", "Plans/A.md", "Plans/Sub/B.md", "Plans-old/C.md"]
                    .map(str::to_owned)
                    .to_vec(),
                ..fields("T")
            },
        )
        .expect("linked");
    let task = board.columns[0].tasks[0].id.clone();
    let links = |project: &Project| project.task_detail(&task).expect("detail").task.notes;

    project
        .notes_moved("Plans", "Archive/Plans")
        .expect("moved");
    assert_eq!(
        links(&project),
        [
            "Archive/Plans/A.md",
            "Archive/Plans/Sub/B.md",
            "Plans-old/C.md",
            "Top.md"
        ]
    );

    // Windows finds a path in any case.
    project.notes_moved("top.md", "Renamed.md").expect("moved");
    assert!(links(&project).contains(&"Renamed.md".to_owned()));

    // A note moved onto a stale link of the same task counts once.
    project
        .notes_moved("Renamed.md", "Plans-old/C.md")
        .expect("moved");
    assert_eq!(links(&project).len(), 3);
}

#[test]
fn a_failed_change_leaves_no_half_task() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    project
        .connection
        .execute_batch(
            "CREATE TRIGGER refuse BEFORE INSERT ON task_tags
             BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        )
        .expect("trigger");

    let task = TaskFields {
        tags: vec!["one".to_owned()],
        ..fields("Half")
    };
    assert!(project.create_task("todo", task).is_err());

    assert!(titles(&project, 0).is_empty());
    let rows: i64 = project
        .connection
        .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, 0);
}

#[test]
fn bad_values_in_a_foreign_file_count_as_not_set() {
    let dir = temp_dir();
    let app = app(dir.path());
    let project = fresh(dir.path(), &app);
    add_tasks(&project, "doing", &["Odd"]);
    let id = id_of(&project, "Odd");
    project
        .connection
        .execute_batch(
            "PRAGMA ignore_check_constraints = ON;
             PRAGMA foreign_keys = OFF;
             UPDATE tasks SET priority = 'evil', due = 'soon', column_id = 'gone',
                 description = CAST(x'ff41' AS TEXT);
             PRAGMA foreign_keys = ON;
             PRAGMA ignore_check_constraints = OFF;",
        )
        .expect("changed by hand");

    let board = project.task_board().expect("still a board");
    let task = &board.columns[0].tasks[0];
    assert_eq!(task.priority, Priority::None);
    assert_eq!(task.due, None);
    assert_eq!(task.id, id, "shows in the first column");

    assert_eq!(
        project.task_detail(&id).expect("detail").description,
        "\u{fffd}A"
    );

    project
        .connection
        .execute(
            "UPDATE tasks SET title = CAST(x'ff' AS TEXT) || ?1",
            params!["x".repeat(600)],
        )
        .expect("long title");
    let task_title = project.task_board().expect("board").columns[0].tasks[0]
        .title
        .clone();
    assert_eq!(task_title.chars().count(), 500);
    assert!(task_title.starts_with('\u{fffd}'));

    // It can still be put right.
    project.move_task(&id, "done", 0).expect("moved");
    assert_eq!(titles(&project, 2).len(), 1);
}

#[test]
fn an_older_project_gains_tasks_after_a_backup_and_keeps_its_data() {
    let dir = temp_dir();
    let app = app(dir.path());
    let old = fixture(dir.path(), "Old", 2);
    {
        let conn = Connection::open(old.database()).expect("open");
        conn.execute(
            "INSERT INTO property_kinds (name, kind) VALUES ('due', 'date')",
            [],
        )
        .expect("a choice");
    }

    let opened = add(&app, &old.root).expect("upgraded");

    assert_eq!(opened.id, old.id);
    assert_eq!(
        opened.property_kinds().expect("kinds"),
        [("due".to_owned(), PropertyKind::Date)]
    );
    assert_eq!(opened.task_board().expect("board").columns.len(), 3);
    opened
        .create_task("todo", fields("Works"))
        .expect("can be written");

    let backups: Vec<_> = fs::read_dir(old.root.join(".liurium").join("backups"))
        .expect("backups")
        .map(|entry| entry.expect("entry").path())
        .collect();
    assert_eq!(backups.len(), 1);
    let saved = Connection::open(&backups[0]).expect("backup");
    let version: i64 = saved
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("version");
    assert_eq!(version, 2);
    assert_eq!(current(Kind::Project), 3);
}

#[test]
fn a_write_protected_older_project_shows_no_tasks_and_stays_as_it_is() {
    let dir = temp_dir();
    let app = app(dir.path());
    let old = fixture(dir.path(), "Archive", 2);
    read_only(&old.database());
    let before = Snapshot::of(&old.database());

    let opened = add(&app, &old.root).expect("opened");

    assert!(opened.read_only);
    assert!(opened.task_board().expect("board").columns.is_empty());
    assert!(opened.trashed_tasks().expect("trash").is_empty());
    assert!(
        opened
            .tasks_with_description("text")
            .expect("nothing to search")
            .is_empty()
    );
    assert!(matches!(opened.task_detail("x"), Err(TaskError::NotFound)));
    opened
        .notes_moved("A.md", "B.md")
        .expect("nothing to follow");
    drop(opened);
    before.assert_unchanged(&old.database());
}
