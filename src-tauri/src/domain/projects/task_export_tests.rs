use super::task_export::render;
use super::tasks::{Board, BoardColumn, Priority, Task, TaskError};
use crate::domain::notes::links::scan;

const ROOM: usize = 1_000_000;

fn task(id: &str, title: &str) -> Task {
    Task {
        id: id.to_owned(),
        title: title.to_owned(),
        has_description: false,
        priority: Priority::None,
        due: None,
        tags: Vec::new(),
        notes: Vec::new(),
        created_ms: 0,
        updated_ms: 0,
        trashed_ms: None,
    }
}

fn board(columns: Vec<(&str, Vec<Task>)>) -> Board {
    Board {
        columns: columns
            .into_iter()
            .map(|(name, tasks)| BoardColumn {
                id: name.to_owned(),
                name: name.to_owned(),
                tasks,
            })
            .collect(),
    }
}

fn none(_: &str) -> Option<String> {
    None
}

/// The file for one task with this description.
fn with_description(description: &str) -> String {
    let text = description.to_owned();
    render(
        "P",
        &board(vec![("C", vec![task("t", "T"), task("u", "U")])]),
        move |id| (id == "t").then(|| text.clone()),
        ROOM,
    )
    .expect("rendered")
}

#[test]
fn the_file_reads_as_columns_with_their_tasks_in_order() {
    let mut first = task("1", "First");
    first.priority = Priority::High;
    first.due = Some("2026-11-02".to_owned());
    first.tags = vec!["garden".to_owned(), "buying".to_owned()];
    first.notes = vec!["Plans/Greenhouse.md".to_owned()];
    let text = render(
        "Garden",
        &board(vec![
            ("To do", vec![first, task("2", "Second")]),
            ("Done", Vec::new()),
        ]),
        |id| (id == "1").then(|| "Some words.\nMore.".to_owned()),
        ROOM,
    )
    .expect("rendered");

    assert_eq!(
        text,
        "# Tasks of Garden\n\n\
         Exported from Liurium. This is a copy: changes here do not change the tasks.\n\n\
         ## To do\n\n\
         ### First\n\n\
         - Priority: High\n\
         - Due: 2026-11-02\n\
         - Tags: `#garden`, `#buying`\n\
         - Notes: `Plans/Greenhouse.md`\n\n\
         ```text\nSome words.\nMore.\n```\n\n\
         ### Second\n\n\
         ## Done\n\n\
         No tasks.\n"
    );
}

#[test]
fn an_unchanged_board_gives_the_very_same_file() {
    let shown = board(vec![("C", vec![task("1", "A")])]);
    assert_eq!(
        render("P", &shown, none, ROOM).expect("rendered"),
        render("P", &shown, none, ROOM).expect("rendered")
    );
}

#[test]
fn a_description_cannot_break_out_of_its_task() {
    for hostile in [
        "# Heading\n## Another\n- list\n> quote\n---\n[[Plan]] #tag $x$ ![i](j.png)",
        "```\n# after a fence",
        "````\n# after a longer fence",
        "```````````\n# after a very long fence\n`",
        "~~~\n# after tildes",
        "line\r# after a lone carriage return\r\n# and a pair",
        "<!-- open a comment\n# Heading",
        "<script>alert(1)</script>",
        "    # indented",
        "%% open a comment\n# Heading",
    ] {
        let found = scan(&with_description(hostile));
        assert_eq!(
            found.headings,
            ["Tasks of P", "C", "T", "U"],
            "for {hostile:?}"
        );
        assert!(found.links.is_empty(), "links for {hostile:?}");
        assert!(found.tags.is_empty(), "tags for {hostile:?}");
        assert!(found.images.is_empty(), "images for {hostile:?}");
        assert!(found.math.is_empty(), "math for {hostile:?}");
    }
}

#[test]
fn a_title_or_column_means_only_itself() {
    for hostile in [
        "# not a heading",
        "[[Plan]] and [[Other|shown]]",
        "#tag and #other/tag",
        "[text](http://example.com) <http://example.com> ![i](j.png)",
        "`code` **bold** _it_ ~~gone~~ ==mark==",
        "$x^2$ and $$y$$",
        "<b>html</b> &amp; &#35;tag",
        "ends in a backslash\\",
        "backslashes \\- \\! \\. \\\\ before marks",
        "a | table | row",
        "two\nlines\r\n# from a foreign file",
        "%% comment %%",
    ] {
        let text = render(
            hostile,
            &board(vec![(hostile, vec![task("1", hostile)])]),
            none,
            ROOM,
        )
        .expect("rendered");
        let found = scan(&text);
        let words: String = hostile
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        assert_eq!(
            found.headings,
            [format!("Tasks of {words}"), words.clone(), words.clone()],
            "for {hostile:?}"
        );
        assert!(found.links.is_empty(), "links for {hostile:?}");
        assert!(found.tags.is_empty(), "tags for {hostile:?}");
        assert!(found.images.is_empty(), "images for {hostile:?}");
        assert!(found.math.is_empty(), "math for {hostile:?}");
    }
}

#[test]
fn a_link_in_a_title_claims_nothing_a_bare_address_stays_an_address() {
    let text = render(
        "P",
        &board(vec![(
            "C",
            vec![task("1", "[bank.example](http://evil.example)")],
        )]),
        none,
        ROOM,
    )
    .expect("rendered");
    let found = scan(&text);

    assert_eq!(found.external.len(), 1);
    assert_eq!(found.external[0].address, "http://evil.example/");
    assert_eq!(found.external[0].claims, None);
    assert_eq!(found.headings[2], "[bank.example](http://evil.example)");
}

#[test]
fn a_title_keeps_its_words_for_a_reader() {
    let text = render(
        "P",
        &board(vec![("C", vec![task("1", "C# & [x]")])]),
        none,
        ROOM,
    )
    .expect("rendered");
    assert_eq!(scan(&text).headings[2], "C# & [x]");
}

#[test]
fn tags_and_note_paths_from_a_foreign_file_cannot_break_their_line() {
    let mut hostile = task("1", "T");
    hostile.tags = vec![
        "a`b".to_owned(),
        "``x".to_owned(),
        "two\nlines".to_owned(),
        String::new(),
    ];
    hostile.notes = vec![
        "[[Plan]].md".to_owned(),
        "`#x\n# y.md".to_owned(),
        String::new(),
    ];
    let text = render("P", &board(vec![("C", vec![hostile])]), none, ROOM).expect("rendered");
    let found = scan(&text);

    assert_eq!(found.headings, ["Tasks of P", "C", "T"]);
    assert!(found.links.is_empty());
    assert!(found.tags.is_empty());
    assert_eq!(
        text.matches("- Tags: ").count() + text.matches("- Notes: ").count(),
        2
    );
}

#[test]
fn empty_tags_and_paths_from_a_foreign_file_leave_nothing() {
    let mut hollow = task("1", "T");
    hollow.tags = vec![String::new()];
    hollow.notes = vec![String::new()];
    let mut mixed = task("2", "U");
    mixed.tags = vec![String::new(), "a".to_owned()];
    mixed.notes = vec![String::new(), "a.md".to_owned()];
    let text = render("P", &board(vec![("C", vec![hollow, mixed])]), none, ROOM).expect("rendered");

    assert_eq!(text.matches("- Tags: ").count(), 1);
    assert!(text.contains("- Tags: `#a`\n"));
    assert_eq!(text.matches("- Notes: ").count(), 1);
    assert!(text.contains("- Notes: `a.md`\n"));
}

#[test]
fn a_lone_carriage_return_is_a_line_and_other_control_characters_are_gone() {
    let text = with_description("one\rtwo\r\nthree\tfour\u{0}five\u{1b}six");
    assert!(text.contains("one\ntwo\nthree\tfour five six\n"));
}

#[test]
fn a_blank_description_leaves_no_empty_block() {
    assert!(!with_description("  \n\t\n").contains("```"));
}

#[test]
fn a_file_past_the_limit_is_refused() {
    let many = board(vec![(
        "C",
        (0..50).map(|n| task(&n.to_string(), "Title")).collect(),
    )]);
    assert!(matches!(
        render("P", &many, none, 100),
        Err(TaskError::Limit)
    ));
}
