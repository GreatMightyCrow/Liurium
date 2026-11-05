use super::*;

fn fields(text: &str) -> Vec<(String, Value)> {
    match read(text) {
        View::Fields { fields, .. } => pairs(&fields),
        other => panic!("no fields: {other:?}"),
    }
}

fn field(name: &str, value: Value) -> (String, Value) {
    (name.to_owned(), value)
}

fn text(value: &str) -> Value {
    Value::Text {
        text: value.to_owned(),
    }
}

fn list(items: &[&str]) -> Value {
    Value::List {
        items: items.iter().map(|item| (*item).to_owned()).collect(),
    }
}

fn set(name: &str, value: Value) -> Edit {
    Edit::Set {
        name: name.to_owned(),
        value,
    }
}

#[test]
fn each_kind_of_value_is_read_from_how_it_is_written() {
    assert_eq!(
        fields(
            "---\ntitle: Plan\nquoted: \"12\"\nsingle: 'true'\ncount: 12\nratio: -1.5\ndone: true\nopen: false\nnone:\ntilde: ~\nday: 2026-10-20\nat: 2026-10-20T08:30\nhex: 0x10\nbad: 2026-13-40\n---\nBody\n"
        ),
        [
            field("title", text("Plan")),
            field("quoted", text("12")),
            field("single", text("true")),
            field(
                "count",
                Value::Number {
                    text: "12".to_owned()
                }
            ),
            field(
                "ratio",
                Value::Number {
                    text: "-1.5".to_owned()
                }
            ),
            field("done", Value::Checkbox { checked: true }),
            field("open", Value::Checkbox { checked: false }),
            field("none", Value::Empty),
            field("tilde", Value::Empty),
            field(
                "day",
                Value::Date {
                    text: "2026-10-20".to_owned()
                }
            ),
            field(
                "at",
                Value::DateTime {
                    text: "2026-10-20T08:30".to_owned()
                }
            ),
            field("hex", text("0x10")),
            field("bad", text("2026-13-40")),
        ]
    );
}

#[test]
fn lists_and_the_fixed_list_names_are_read_as_lists() {
    assert_eq!(
        fields(
            "---\ntags: a, b c\naliases: One name\nfriends:\n  - Ann\n  - Bob\nflow: [x, 'y z']\nempty: []\ntag:\n---\n"
        ),
        [
            field("tags", list(&["a", "b", "c"])),
            field("aliases", list(&["One name"])),
            field("friends", list(&["Ann", "Bob"])),
            field("flow", list(&["x", "y z"])),
            field("empty", list(&[])),
            field("tag", list(&[])),
        ]
    );
}

#[test]
fn what_the_box_cannot_change_safely_shows_as_written() {
    let note = "---\nnested:\n  a: 1\nlong: |\n  one\n  two\nfolded: one\n  two\nmixed: [a, {b: c}]\n\"quoted key\": x\nnoted:\n  - a # why\n---\n";
    let found = fields(note);
    assert!(
        found
            .iter()
            .all(|(_, value)| matches!(value, Value::AsText { .. })),
        "{found:?}"
    );
    assert_eq!(
        found[0],
        field(
            "nested",
            Value::AsText {
                source: "nested:\n  a: 1".to_owned()
            }
        )
    );
}

#[test]
fn a_block_that_cannot_be_judged_line_by_line_stays_text() {
    for note in [
        "---\ntags: [unclosed\n---\n",
        "---\n- a\n- b\n---\n",
        "---\nplain text\n---\n",
        "---\na: 1\na: 2\n---\n",
        "---\nbase: &b [x]\nother: *b\n---\n",
        "---\ntyped: !!str 12\n---\n",
        "---\n  indented: 1\n---\n",
        "---\n{a: 1, b: 2}\n---\n",
    ] {
        assert_eq!(read(note), View::AsText, "{note}");
    }
}

#[test]
fn no_closed_block_at_the_start_means_no_box() {
    assert_eq!(read("# Title\n---\na: 1\n---\n"), View::None);
    assert_eq!(read("---\na: 1\nno end"), View::None);
    assert_eq!(read(""), View::None);
}

#[test]
fn an_empty_block_has_no_fields_and_its_range_covers_both_marker_lines() {
    let note = "---\n# only a comment\n---\nBody";
    assert_eq!(
        read(note),
        View::Fields {
            range: 0..25,
            fields: Vec::new()
        }
    );
    assert_eq!(&note[25..], "Body");
    let View::Fields { range, .. } = read("---\r\na: 1\r\n...\r\nBody") else {
        panic!("fields");
    };
    assert_eq!(range, 0..16);
}

#[test]
fn deep_huge_and_alias_bomb_blocks_stay_text_and_never_panic() {
    let deep = format!(
        "---\na: {}x{}\n---\n",
        "[".repeat(10_000),
        "]".repeat(10_000)
    );
    assert_eq!(read(&deep), View::AsText);
    let huge = format!("---\na: '{}'\n---\n", "x".repeat(70 * 1024));
    assert_eq!(read(&huge), View::AsText);
    let laughs = "---\na: &a [x, x, x]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]\n---\n";
    assert_eq!(read(laughs), View::AsText);
}

#[test]
fn changing_a_value_changes_only_its_line() {
    let note = "---\n# Why this note exists\ntitle: Plan # keep\n\n# Status\nstatus: open\ncount: 1\n---\nBody\n";
    assert_eq!(
        edit(note, &set("status", text("done"))).as_deref(),
        Ok(
            "---\n# Why this note exists\ntitle: Plan # keep\n\n# Status\nstatus: done\ncount: 1\n---\nBody\n"
        )
    );
    assert_eq!(
        edit(note, &set("title", text("New"))).as_deref(),
        Ok(
            "---\n# Why this note exists\ntitle: New # keep\n\n# Status\nstatus: open\ncount: 1\n---\nBody\n"
        )
    );
}

#[test]
fn line_endings_stay_as_the_note_has_them() {
    let note = "---\r\na: 1\r\nb: 2\r\n---\r\nBody\r\n";
    assert_eq!(
        edit(note, &set("a", list(&["p", "q"]))).as_deref(),
        Ok("---\r\na:\r\n  - p\r\n  - q\r\nb: 2\r\n---\r\nBody\r\n")
    );
    assert_eq!(
        edit("No block\r\n", &set("a", Value::Empty)).as_deref(),
        Ok("---\r\na:\r\n---\r\nNo block\r\n")
    );
}

#[test]
fn texts_are_quoted_when_yaml_would_read_them_differently() {
    let cases = [
        ("plain words", "plain words"),
        ("12", "\"12\""),
        ("true", "\"true\""),
        ("null", "\"null\""),
        ("yes", "\"yes\""),
        ("Off", "\"Off\""),
        ("2026-10-20", "\"2026-10-20\""),
        ("a: b", "\"a: b\""),
        ("a #b", "\"a #b\""),
        ("#tag", "\"#tag\""),
        ("- item", "\"- item\""),
        ("[x]", "\"[x]\""),
        ("say \"hi\"", "say \"hi\""),
        ("\"both\" \\ ways", "\"\\\"both\\\" \\\\ ways\""),
        (" padded ", "\" padded \""),
        ("Grüße 日本語", "Grüße 日本語"),
        ("", "\"\""),
    ];
    for (value, written) in cases {
        let note = edit("---\na: 1\n---\n", &set("a", text(value))).expect(value);
        assert_eq!(note, format!("---\na: {written}\n---\n"));
        assert_eq!(fields(&note), [field("a", text(value))], "{value}");
    }
}

#[test]
fn list_items_are_quoted_the_same_way() {
    let note = edit(
        "---\nx: 1\n---\n",
        &set("x", list(&["plain", "a: b", "12", "- dash"])),
    )
    .expect("list");
    assert_eq!(
        note,
        "---\nx:\n  - plain\n  - \"a: b\"\n  - \"12\"\n  - \"- dash\"\n---\n"
    );
    assert_eq!(
        fields(&note),
        [field("x", list(&["plain", "a: b", "12", "- dash"]))]
    );
}

#[test]
fn each_kind_can_be_written_and_reads_back() {
    for value in [
        Value::Empty,
        Value::Number {
            text: "-3.25".to_owned(),
        },
        Value::Checkbox { checked: true },
        Value::Date {
            text: "2027-01-31".to_owned(),
        },
        Value::DateTime {
            text: "2027-01-31T23:59:58".to_owned(),
        },
        list(&[]),
    ] {
        let note = edit("---\nk: old\n---\n", &set("k", value.clone())).expect("written");
        assert_eq!(fields(&note), [field("k", value)]);
    }
}

#[test]
fn values_that_do_not_fit_their_kind_are_refused() {
    let note = "---\nk: old\n---\n";
    for value in [
        Value::Number {
            text: "twelve".to_owned(),
        },
        Value::Date {
            text: "2027-13-01".to_owned(),
        },
        Value::DateTime {
            text: "2027-01-01T25:00".to_owned(),
        },
        Value::AsText {
            source: "k: x".to_owned(),
        },
    ] {
        assert_eq!(edit(note, &set("k", value)), Err(EditError::Refused));
    }
}

#[test]
fn a_new_property_goes_to_the_end_of_the_block() {
    assert_eq!(
        edit("---\na: 1\n# end\n---\nBody", &set("b", text("x"))).as_deref(),
        Ok("---\na: 1\n# end\nb: x\n---\nBody")
    );
}

#[test]
fn a_note_without_a_block_gains_one_at_its_very_start() {
    assert_eq!(
        edit("# Title\n", &set("status", text("open"))).as_deref(),
        Ok("---\nstatus: open\n---\n# Title\n")
    );
    assert_eq!(
        edit("", &set("a", Value::Empty)).as_deref(),
        Ok("---\na:\n---\n")
    );
    // An unclosed marker stays body text below the new block.
    assert_eq!(
        edit("---\nno end\n", &set("a", text("x"))).as_deref(),
        Ok("---\na: x\n---\n---\nno end\n")
    );
    assert_eq!(
        edit(
            "Body",
            &Edit::Remove {
                name: "a".to_owned()
            }
        ),
        Err(EditError::Refused)
    );
}

#[test]
fn renaming_changes_only_the_name() {
    let note = "---\nold: 1 # why\nfriends:\n  - Ann\nz: 2\n---\n";
    let rename = |name: &str, to: &str| Edit::Rename {
        name: name.to_owned(),
        to: to.to_owned(),
    };
    assert_eq!(
        edit(note, &rename("old", "new name")).as_deref(),
        Ok("---\nnew name: 1 # why\nfriends:\n  - Ann\nz: 2\n---\n")
    );
    assert_eq!(
        edit(note, &rename("friends", "people")).as_deref(),
        Ok("---\nold: 1 # why\npeople:\n  - Ann\nz: 2\n---\n")
    );
    assert_eq!(edit(note, &rename("old", "z")), Err(EditError::NameTaken));
    assert_eq!(edit(note, &rename("old", "old")).as_deref(), Ok(note));
    assert_eq!(edit(note, &rename("gone", "x")), Err(EditError::Refused));
    assert_eq!(
        edit(note, &rename("old", "a: b")),
        Err(EditError::InvalidName)
    );
}

#[test]
fn removing_takes_only_its_lines_and_keeps_the_empty_block() {
    let note = "---\n# top\na: 1\nfriends:\n  - Ann\n# bottom\nz: 2\n---\nBody";
    let remove = |name: &str| Edit::Remove {
        name: name.to_owned(),
    };
    assert_eq!(
        edit(note, &remove("friends")).as_deref(),
        Ok("---\n# top\na: 1\n# bottom\nz: 2\n---\nBody")
    );
    assert_eq!(
        edit("---\na: 1\n---\nBody", &remove("a")).as_deref(),
        Ok("---\n---\nBody")
    );
}

#[test]
fn names_that_need_quotes_are_refused() {
    let note = "---\na: 1\n---\n";
    for name in ["", " x", "x ", "a:b", "#x", "-x", "x\ny", "\"x\""] {
        assert_eq!(
            edit(note, &set(name, Value::Empty)),
            Err(EditError::InvalidName),
            "{name:?}"
        );
    }
    let long = "x".repeat(MAX_NAME_CHARS + 1);
    assert_eq!(
        edit(note, &set(&long, Value::Empty)),
        Err(EditError::InvalidName)
    );
    assert!(edit(note, &set("Größe in cm", Value::Empty)).is_ok());
}

#[test]
fn entries_shown_as_written_are_never_edited() {
    let note = "---\nnested:\n  a: 1\nz: 2\n---\n";
    assert_eq!(
        edit(note, &set("nested", text("x"))),
        Err(EditError::Refused)
    );
    assert_eq!(
        edit(
            note,
            &Edit::Remove {
                name: "nested".to_owned()
            }
        ),
        Err(EditError::Refused)
    );
    assert_eq!(
        edit(
            note,
            &Edit::Rename {
                name: "nested".to_owned(),
                to: "x".to_owned()
            }
        ),
        Err(EditError::Refused)
    );
    assert_eq!(
        edit(note, &set("z", text("3"))).as_deref(),
        Ok("---\nnested:\n  a: 1\nz: \"3\"\n---\n")
    );
}

#[test]
fn a_block_shown_as_text_refuses_every_edit() {
    assert_eq!(
        edit("---\nbad: [unclosed\n---\n", &set("a", Value::Empty)),
        Err(EditError::Refused)
    );
}

#[test]
fn new_tags_must_be_tags_but_old_odd_ones_may_stay() {
    let note = "---\ntags: [ok, 2026]\n---\n";
    assert_eq!(
        edit(note, &set("tags", list(&["ok", "2026", "two words"]))),
        Err(EditError::InvalidTag)
    );
    assert_eq!(
        edit(note, &set("tags", list(&["ok", "2026", "topic/sub"]))).as_deref(),
        Ok("---\ntags:\n  - ok\n  - \"2026\"\n  - topic/sub\n---\n")
    );
    assert_eq!(
        edit("Body", &set("tags", list(&["#bad"]))),
        Err(EditError::InvalidTag)
    );
    // Other lists hold any text.
    assert!(edit(note, &set("friends", list(&["two words"]))).is_ok());
}

#[test]
fn the_tags_liurium_reads_for_the_project_follow_an_edit() {
    let note = edit(
        "---\ntags: [old]\n---\n",
        &set("tags", list(&["new", "topic/sub"])),
    )
    .expect("edit");
    assert_eq!(meta::read(&note).tags, ["new", "topic/sub"]);
}

#[test]
fn comments_after_quoted_values_stay() {
    assert_eq!(
        edit("---\na: \"x # y\" # why\n---\n", &set("a", text("z"))).as_deref(),
        Ok("---\na: z # why\n---\n")
    );
    assert_eq!(
        edit("---\na: # why\n---\n", &set("a", text("z"))).as_deref(),
        Ok("---\na: z # why\n---\n")
    );
    // A `#` inside a plain word is no comment.
    assert_eq!(
        edit("---\na: c#d\n---\n", &set("a", text("z"))).as_deref(),
        Ok("---\na: z\n---\n")
    );
}

#[test]
fn a_commented_value_is_not_turned_into_a_list_because_the_comment_would_go() {
    assert_eq!(
        edit("---\na: x # why\n---\n", &set("a", list(&["p"]))),
        Err(EditError::Refused)
    );
    assert_eq!(
        edit("---\na: x # why\n---\n", &set("a", list(&[]))),
        Err(EditError::Refused)
    );
}

#[test]
fn the_body_is_never_read_as_front_matter_or_changed() {
    let note = "---\na: 1\n---\n---\nb: 2\n---\nBody";
    assert_eq!(
        edit(note, &set("a", text("x"))).as_deref(),
        Ok("---\na: x\n---\n---\nb: 2\n---\nBody")
    );
    assert_eq!(
        fields(note),
        [field(
            "a",
            Value::Number {
                text: "1".to_owned()
            }
        )]
    );
}
