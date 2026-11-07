use super::*;

fn links(text: &str) -> Vec<(String, Option<Anchor>, bool, &'static str)> {
    parse(text)
        .into_iter()
        .map(|link| (link.target, link.anchor, link.embed, link.kind.as_str()))
        .collect()
}

fn heading(text: &str) -> Option<Anchor> {
    Some(Anchor::Heading(text.to_owned()))
}

#[test]
fn wikilinks_in_every_form_are_found_with_their_ranges() {
    let text =
        "a [[Plan]] b [[Plan|my plan]] [[Plan#Next steps]] [[Plan#^abc]] ![[Ideas/Plan]] [[#Top]]";

    let found = parse(text);

    assert_eq!(
        links(text),
        [
            ("Plan".into(), None, false, "wiki"),
            ("Plan".into(), None, false, "wiki"),
            ("Plan".into(), heading("Next steps"), false, "wiki"),
            (
                "Plan".into(),
                Some(Anchor::Block("abc".into())),
                false,
                "wiki"
            ),
            ("Ideas/Plan".into(), None, true, "wiki"),
            (String::new(), heading("Top"), false, "wiki"),
        ]
    );
    assert_eq!(&text[found[0].range.clone()], "[[Plan]]");
    assert_eq!(&text[found[1].range.clone()], "[[Plan|my plan]]");
    assert_eq!(&text[found[4].range.clone()], "![[Ideas/Plan]]");
}

#[test]
fn markdown_links_count_only_for_note_paths_without_a_scheme() {
    let text = "[a](Ideas/Plan.md) [b](<My Notes/Plan v2.md>) [c](My%20Notes/x.md#next-steps) \
        [d](https://example.org/x.md) [e](javascript:alert(1)) [f](C:/x.md) [g](image.png) \
        [h](#local) [i][ref] <https://example.org>\n\n[ref]: Ref.md";

    assert_eq!(
        links(text),
        [
            ("Ideas/Plan.md".into(), None, false, "markdown"),
            ("My Notes/Plan v2.md".into(), None, false, "markdown"),
            (
                "My Notes/x.md".into(),
                heading("next-steps"),
                false,
                "markdown"
            ),
            (String::new(), heading("local"), false, "markdown"),
            ("Ref.md".into(), None, false, "markdown"),
        ]
    );
}

#[test]
fn links_in_code_comments_and_front_matter_are_not_links() {
    let text = "---\nup: \"[[Front]]\"\n---\n`[[Inline]]` %%[[Hidden]]%% [[Kept]]\n\n\
        ```\n[[Fenced]]\n```\n\n%%\nblock [[Block hidden]]\n%%\n\n`%%` [[After code]]";

    let targets: Vec<String> = parse(text).into_iter().map(|link| link.target).collect();

    assert_eq!(targets, ["Kept", "After code"]);
}

#[test]
fn front_matter_counts_only_at_the_start() {
    let text = "# Title\n\n---\nnot: front matter [[Linked]]\n---\n";
    let targets: Vec<String> = parse(text).into_iter().map(|link| link.target).collect();
    assert_eq!(targets, ["Linked"]);
}

#[test]
fn an_escaped_pipe_in_a_table_keeps_the_target_clean() {
    let text = "| a | b |\n|---|---|\n| [[Plan\\|text]] | x |\n";
    assert_eq!(links(text), [("Plan".into(), None, false, "wiki")]);
}

fn notes() -> NoteSet {
    NoteSet::new(
        [
            "Plan.md",
            "Ideas/Plan.md",
            "Ideas/Unique.md",
            "Work/Deep/Report.markdown",
            "Read.Me.md",
            "My Notes/Plan v2.md",
        ]
        .map(String::from),
    )
}

fn wiki(target: &str) -> Link {
    parse(&format!("[[{target}]]")).remove(0)
}

fn markdown(target: &str) -> Link {
    parse(&format!("[x](<{target}>)")).remove(0)
}

fn note(path: &str) -> Target {
    Target::Note { path: path.into() }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

#[test]
fn names_resolve_without_case_and_several_matches_are_ambiguous() {
    let set = notes();
    let source = rel("Ideas/Source.md");

    assert_eq!(
        resolve(&source, &wiki("unique"), &set),
        note("Ideas/Unique.md")
    );
    assert_eq!(
        resolve(&source, &wiki("Report"), &set),
        note("Work/Deep/Report.markdown")
    );
    assert_eq!(resolve(&source, &wiki("Read.Me"), &set), note("Read.Me.md"));
    assert_eq!(
        resolve(&source, &wiki("Unique.md"), &set),
        note("Ideas/Unique.md")
    );
    assert_eq!(
        resolve(&source, &wiki("plan"), &set),
        Target::Ambiguous {
            candidates: vec!["Ideas/Plan.md".into(), "Plan.md".into()]
        }
    );
}

#[test]
fn paths_resolve_from_the_root_or_as_the_end_of_one_path() {
    let set = notes();
    let source = rel("Source.md");

    assert_eq!(
        resolve(&source, &wiki("Ideas/Plan"), &set),
        note("Ideas/Plan.md")
    );
    assert_eq!(
        resolve(&source, &wiki("Deep/Report"), &set),
        note("Work/Deep/Report.markdown")
    );
    assert_eq!(
        resolve(&source, &wiki("Other/Plan"), &set),
        Target::Missing {
            path: "Other/Plan.md".into()
        }
    );
}

#[test]
fn a_missing_name_is_created_next_to_the_linking_note() {
    let set = notes();

    assert_eq!(
        resolve(&rel("Ideas/Source.md"), &wiki("Neue Idee"), &set),
        Target::Missing {
            path: "Ideas/Neue Idee.md".into()
        }
    );
    assert_eq!(
        resolve(&rel("Top.md"), &wiki("Neue Idee"), &set),
        Target::Missing {
            path: "Neue Idee.md".into()
        }
    );
}

#[test]
fn markdown_links_resolve_relative_to_the_note() {
    let set = notes();
    let source = rel("Ideas/Source.md");

    assert_eq!(
        resolve(&source, &markdown("Plan.md"), &set),
        note("Ideas/Plan.md")
    );
    assert_eq!(
        resolve(&source, &markdown("../Plan.md"), &set),
        note("Plan.md")
    );
    assert_eq!(
        resolve(&rel("Top.md"), &markdown("My Notes/Plan v2.md"), &set),
        note("My Notes/Plan v2.md")
    );
    assert_eq!(
        resolve(&source, &markdown("New.md"), &set),
        Target::Missing {
            path: "Ideas/New.md".into()
        }
    );
}

#[test]
fn targets_outside_or_in_protected_places_are_never_note_links() {
    let set = notes();
    let source = rel("Ideas/Source.md");

    for link in [
        markdown("../../outside.md"),
        markdown("../.liurium/x.md"),
        markdown("node_modules/x.md"),
        wiki(".git/config"),
        wiki("../../up"),
        wiki("CON"),
        wiki("diagram.png"),
    ] {
        assert_eq!(resolve(&source, &link, &set), Target::NotNote, "{link:?}");
    }
    assert_eq!(
        resolve(&source, &wiki("#Top"), &set),
        note("Ideas/Source.md")
    );
}

#[test]
fn link_text_is_the_name_or_the_shortest_unique_path() {
    let set = notes();
    assert_eq!(set.link_text("Ideas/Unique.md"), "Unique");
    assert_eq!(set.link_text("Ideas/Plan.md"), "Ideas/Plan");
    assert_eq!(set.link_text("Plan.md"), "Plan.md");
    assert_eq!(set.link_text("Work/Deep/Report.markdown"), "Report");
}

#[test]
fn byte_offsets_become_utf16_offsets() {
    let text = "ä😀[[x]]";
    let start = text.find("[[").expect("link");
    assert_eq!(utf16_offsets(text, &[start, text.len(), 0]), [3, 8, 0]);
}

fn tags(text: &str) -> Vec<String> {
    scan(text).tags.into_iter().map(|tag| tag.tag).collect()
}

#[test]
fn inline_tags_follow_the_rules() {
    assert_eq!(
        tags("Tags: #project #topic/sub, (#idee) #2026 #2026-plan not#tag C# #ä_ö-1 #trail/"),
        [
            "project",
            "topic/sub",
            "idee",
            "2026-plan",
            "ä_ö-1",
            "trail"
        ]
    );
    assert_eq!(tags("# Heading is no tag\n## Next #real"), ["real"]);
}

#[test]
fn tags_in_code_comments_front_matter_and_escapes_do_not_count() {
    let text = "---\ntags: [front]\n---\n`#inline` %%#hidden%% \\#escaped [url](https://x.org/#frag) #kept\n\n```\n#fenced\n```\n";
    assert_eq!(tags(text), ["kept"]);
}

#[test]
fn a_tag_range_covers_the_hash_and_the_tag() {
    let text = "ä #Plan next";
    let found = scan(text).tags;
    assert_eq!(&text[found[0].range.clone()], "#Plan");
}

#[test]
fn aliases_resolve_like_names_and_make_shared_names_ambiguous() {
    let set = NoteSet::with_aliases(
        ["Ideas/Plan 2027.md", "Roadmap.md", "Other.md"].map(String::from),
        &[
            ("Ideas/Plan 2027.md".into(), "Roadmap".into()),
            ("Ideas/Plan 2027.md".into(), "Next year".into()),
            ("Missing.md".into(), "Ghost".into()),
        ],
    );
    let source = rel("Other.md");

    assert_eq!(
        resolve(&source, &wiki("next year"), &set),
        note("Ideas/Plan 2027.md")
    );
    assert_eq!(
        resolve(&source, &wiki("Roadmap"), &set),
        Target::Ambiguous {
            candidates: vec!["Ideas/Plan 2027.md".into(), "Roadmap.md".into()]
        }
    );
    assert_eq!(
        resolve(&source, &wiki("Ghost"), &set),
        Target::Missing {
            path: "Ghost.md".into()
        }
    );
    assert_eq!(set.link_text("Roadmap.md"), "Roadmap.md");
    assert_eq!(set.link_text("Ideas/Plan 2027.md"), "Plan 2027");
}

// External links (M3-012).

fn external(text: &str) -> Vec<(String, String, Option<String>)> {
    scan(text)
        .external
        .into_iter()
        .map(|link| (text[link.range].to_owned(), link.address, link.claims))
        .collect()
}

fn found(text: &str, address: &str) -> (String, String, Option<String>) {
    (text.to_owned(), address.to_owned(), None)
}

#[test]
fn each_form_of_external_link_is_found_and_is_no_note_link() {
    let text = "[docs](https://example.org/docs) and <https://example.org/a> and <a@example.org>\n\n[ref][r]\n\n[r]: http://example.org/r\n";
    assert_eq!(
        external(text),
        [
            found(
                "[docs](https://example.org/docs)",
                "https://example.org/docs"
            ),
            found("<https://example.org/a>", "https://example.org/a"),
            found("<a@example.org>", "mailto:a@example.org"),
            found("[ref][r]", "http://example.org/r"),
        ]
    );
    assert_eq!(parse(text), []);
}

#[test]
fn bare_addresses_count_in_text_but_not_in_code_comments_or_front_matter() {
    let text = "---\nurl: https://front.example\n---\nSee https://example.org/a_b_c, then.\n\n`https://code.example`\n\n```\nhttps://block.example\n```\n\n%%https://comment.example%%\n\n    https://indented.example\n";
    assert_eq!(
        external(text),
        [found(
            "https://example.org/a_b_c",
            "https://example.org/a_b_c"
        )]
    );
}

#[test]
fn a_bare_address_cut_by_the_parser_counts_once() {
    let text = "https://example.org/x_y_z*a*b and https://example.org/two\n";
    let links = external(text);
    assert_eq!(links.len(), 2, "{links:?}");
    assert_eq!(links[1].1, "https://example.org/two");
}

#[test]
fn an_address_as_link_text_is_not_a_second_link() {
    let text = "[https://example.org/a](https://example.org/b)\n";
    assert_eq!(
        external(text),
        [found(
            "[https://example.org/a](https://example.org/b)",
            "https://example.org/b"
        )]
    );
    assert_eq!(external("![https://example.org/a](pic.png)\n"), []);
}

#[test]
fn refused_addresses_are_not_links() {
    assert_eq!(
        external(
            "[x](javascript:alert(1)) [y](file:///C:/a) [z](https://u:p@example.org) [m](mailto:a@example.org?attach=C:/s)\n"
        ),
        []
    );
    assert_eq!(external("https://u:p@example.org\n"), []);
}

#[test]
fn a_text_claiming_another_address_is_passed_on() {
    let links = external("[www.meinebank.de](https://boese-seite.example)\n");
    assert_eq!(links[0].2.as_deref(), Some("www.meinebank.de"));
    let links = external("[`www.meinebank.de`](https://boese-seite.example)\n");
    assert_eq!(links[0].2.as_deref(), Some("www.meinebank.de"));
    assert_eq!(
        external("[the bank](https://boese-seite.example)\n")[0].2,
        None
    );
}

#[test]
fn a_fragment_in_an_address_is_no_tag() {
    let found = scan("https://example.org/?a=#frag and #real\n");
    assert_eq!(found.tags.len(), 1);
    assert_eq!(found.tags[0].tag, "real");
}

#[test]
fn note_links_stay_note_links_next_to_external_ones() {
    let text = "[[Plan]] https://example.org [a](Plan.md)\n";
    let found = scan(text);
    assert_eq!(found.links.len(), 2);
    assert_eq!(found.external.len(), 1);
}

fn math(text: &str) -> Vec<(String, String, bool)> {
    scan(text)
        .math
        .into_iter()
        .map(|found| (text[found.range].to_owned(), found.tex, found.display))
        .collect()
}

#[test]
fn formulas_are_found_inline_and_as_blocks() {
    assert_eq!(
        math("a $x^2$ b\n\n$$\ny\n$$\n\n$$z$$\n"),
        [
            ("$x^2$".to_owned(), "x^2".to_owned(), false),
            ("$$\ny\n$$".to_owned(), "\ny\n".to_owned(), true),
            ("$$z$$".to_owned(), "z".to_owned(), true),
        ]
    );
}

#[test]
fn prices_are_no_formulas() {
    assert_eq!(math("costs $5 and $6 today\n"), []);
    assert_eq!(math("costs $5-$6 today\n"), []);
    assert_eq!(math("costs $5-$60\n"), []);
}

#[test]
fn a_digit_before_or_a_letter_after_does_not_stop_a_formula() {
    assert_eq!(math("2$x$\n").len(), 1);
    assert_eq!(math("$x$a\n").len(), 1);
    assert_eq!(math("$x$ 5\n").len(), 1);
}

#[test]
fn what_is_not_a_formula_stays_text() {
    assert_eq!(math("$ x$ and $x $\n"), []);
    assert_eq!(math("`$x$`\n"), []);
    assert_eq!(math("\\$x$\n"), []);
    assert_eq!(math("```\n$x$\n```\n"), []);
    assert_eq!(math("%% $x$ %%\n"), []);
}

#[test]
fn an_empty_formula_would_show_as_nothing_so_it_stays_text() {
    assert_eq!(math("$$$$\n"), []);
    assert_eq!(math("$$\n\n$$\n"), []);
}

#[test]
fn a_formula_in_an_image_text_belongs_to_the_image() {
    assert_eq!(math("![$x$](pic.png)\n"), []);
}

#[test]
fn a_very_long_formula_stays_text() {
    let fits = format!("${}$\n", "x".repeat(MAX_FORMULA_BYTES));
    let long = format!("${}$\n", "x".repeat(MAX_FORMULA_BYTES + 1));
    assert_eq!(math(&fits).len(), 1);
    assert_eq!(math(&long), []);
}

#[test]
fn a_formula_keeps_a_tag_and_a_comment_mark_as_its_own_text() {
    let found = scan("$a #b %% c$ and #real\n");
    assert_eq!(found.math.len(), 1);
    assert_eq!(found.tags.len(), 1);
    assert_eq!(found.tags[0].tag, "real");
}

#[test]
fn a_formula_in_a_table_cell_loses_the_escape_of_its_pipe() {
    let text = "| a |\n| - |\n| $x\\|y$ |\n";
    assert_eq!(
        math(text),
        [("$x\\|y$".to_owned(), "x|y".to_owned(), false)]
    );
}

#[test]
fn front_matter_holds_no_formulas() {
    assert_eq!(math("---\nprice: $x$\n---\n$y$\n").len(), 1);
    assert_eq!(math("---\nprice: $x$\n---\n$y$\n")[0].1, "y");
}
