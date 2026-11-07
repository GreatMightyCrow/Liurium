use std::time::{Duration, UNIX_EPOCH};

use super::super::links::scan;
use super::*;

fn found(path: &str) -> FoundImage {
    FoundImage {
        path: RelPath::parse(path).expect("path"),
        stamp: Stamp {
            len: 7,
            modified: UNIX_EPOCH + Duration::from_secs(1),
        },
    }
}

fn set() -> ImageSet {
    ImageSet::new(
        [
            "top.png",
            "Ideas/near.png",
            "Ideas/assets/deep.jpg",
            "assets/shared.png",
            "One/same.png",
            "Two/same.png",
            "Größe 1.png",
        ]
        .map(found)
        .to_vec(),
    )
}

fn only(text: &str) -> ImageLink {
    let mut images = scan(text).images;
    assert_eq!(images.len(), 1, "{text}");
    images.remove(0)
}

fn resolved(source: &str, text: &str) -> ResolvedImage {
    set().resolve(&RelPath::parse(source).expect("source"), &only(text))
}

fn found_path(result: ResolvedImage) -> String {
    match result {
        ResolvedImage::Found(image) => image.path,
        other => panic!("not found: {other:?}"),
    }
}

#[test]
fn both_forms_are_images_with_their_range_and_text() {
    let text = "a ![Cat](pic.png) b ![[other.jpg]]";
    let images = scan(text).images;
    assert_eq!(images.len(), 2);
    assert_eq!(&text[images[0].range.clone()], "![Cat](pic.png)");
    assert_eq!(images[0].target, ImageTarget::Relative("pic.png".into()));
    assert_eq!(images[0].alt, "Cat");
    assert_eq!(&text[images[1].range.clone()], "![[other.jpg]]");
    assert_eq!(images[1].target, ImageTarget::Wiki("other.jpg".into()));
    assert_eq!(images[1].alt, "other.jpg");
}

#[test]
fn sizes_are_read_as_in_obsidian() {
    let cases = [
        ("![[p.png|200]]", "p.png", Some(200), None),
        ("![[p.png|200x100]]", "p.png", Some(200), Some(100)),
        ("![[p.png|Cat]]", "Cat", None, None),
        ("![[p.png|Cat|200]]", "Cat", Some(200), None),
        ("![Cat|200](p.png)", "Cat", Some(200), None),
        ("![Cat|200x50](p.png)", "Cat", Some(200), Some(50)),
        ("![|200](p.png)", "p.png", Some(200), None),
        // Plain alt text that happens to be a number.
        ("![200](p.png)", "200", None, None),
        // Not sizes.
        ("![[p.png|0]]", "0", None, None),
        ("![[p.png|99999]]", "99999", None, None),
        ("![[p.png|12x]]", "12x", None, None),
        ("![[p.png|x12]]", "x12", None, None),
    ];
    for (text, alt, width, height) in cases {
        let image = only(text);
        assert_eq!(image.alt, alt, "{text}");
        assert_eq!(image.width, width, "{text}");
        assert_eq!(image.height, height, "{text}");
    }
}

#[test]
fn what_is_no_image_stays_text() {
    for text in [
        "![a](data:image/png;base64,AAAA)",
        "![a](file:///C:/x.png)",
        "![a](javascript:alert(1))",
        "![a](C:/x.png)",
        "![a](pic.png:stream.png)",
        "![a](mailto:a@example.com)",
        "![a](Plan.md)",
        "![a](notes)",
        "![[Plan]]",
        "![[Plan.md]]",
        "`![a](x.png)`",
        "%%![a](x.png)%%",
        "```\n![a](x.png)\n```",
    ] {
        assert!(scan(text).images.is_empty(), "{text}");
    }
}

#[test]
fn an_svg_is_an_image_like_any_other() {
    assert_eq!(
        only("![a](pics/x.SVG)").target,
        ImageTarget::Relative("pics/x.SVG".into())
    );
    assert_eq!(only("![[x.svg]]").target, ImageTarget::Wiki("x.svg".into()));
    assert_eq!(only("![[pics/x.svg]]").alt, "x.svg");
    assert_eq!(only("![[x.svg|200]]").width, Some(200));
    assert_eq!(
        only("![a](https://example.com/x.svg)").target,
        ImageTarget::Remote("https://example.com/x.svg".into())
    );
    assert!(scan("![a](x.svgz) ![[y.svgz]]").images.is_empty());
}

#[test]
fn a_front_matter_never_holds_images() {
    assert!(scan("---\ncover: ![a](x.png)\n---\nbody").images.is_empty());
}

#[test]
fn remote_images_are_named_and_nothing_else() {
    let image = only("![a](https://example.com/x.gif?y=1)");
    assert_eq!(
        image.target,
        ImageTarget::Remote("https://example.com/x.gif?y=1".into())
    );
    // Without an image ending too: only its address says what it is.
    assert!(matches!(
        only("![a](http://example.com/pixel)").target,
        ImageTarget::Remote(_)
    ));
    // `checked_address` refuses a host hidden behind a user name.
    assert!(
        scan("![a](https://bank.example@evil.example/x.png)")
            .images
            .is_empty()
    );
}

#[test]
fn an_image_inside_an_image_is_its_text() {
    let images = scan("![a ![b](in.png)](out.png)").images;
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].target, ImageTarget::Relative("out.png".into()));
}

#[test]
fn an_image_in_a_link_and_a_table_is_found() {
    assert_eq!(scan("[![a](p.png)](https://example.com)").images.len(), 1);
    let image = only("| a |\n|---|\n| ![[p.png\\|200]] |\n");
    assert_eq!(image.target, ImageTarget::Wiki("p.png".into()));
    assert_eq!(image.width, Some(200));
}

#[test]
fn a_relative_path_starts_beside_the_note_then_at_the_root() {
    assert_eq!(
        found_path(resolved("Ideas/n.md", "![a](near.png)")),
        "Ideas/near.png"
    );
    assert_eq!(
        found_path(resolved("Ideas/n.md", "![a](assets/deep.jpg)")),
        "Ideas/assets/deep.jpg"
    );
    assert_eq!(
        found_path(resolved("Ideas/n.md", "![a](../assets/shared.png)")),
        "assets/shared.png"
    );
    assert_eq!(
        found_path(resolved("Ideas/n.md", "![a](top.png)")),
        "top.png"
    );
    assert_eq!(
        found_path(resolved("n.md", "![a](assets/shared.png)")),
        "assets/shared.png"
    );
    assert_eq!(
        found_path(resolved("n.md", "![a](Gr%C3%B6%C3%9Fe%201.png)")),
        "Größe 1.png"
    );
    assert_eq!(
        found_path(resolved("n.md", "![a](TOP.PNG)")),
        "top.png",
        "without case, as Windows names are"
    );
    assert_eq!(
        resolved("n.md", "![a](nope.png)"),
        ResolvedImage::Missing("nope.png".into())
    );
    // Relative paths are never looked up by name alone.
    assert_eq!(
        resolved("n.md", "![a](near.png)"),
        ResolvedImage::Missing("near.png".into())
    );
}

#[test]
fn a_wikilink_finds_by_name_and_never_guesses() {
    assert_eq!(
        found_path(resolved("n.md", "![[deep.jpg]]")),
        "Ideas/assets/deep.jpg"
    );
    assert_eq!(
        found_path(resolved("n.md", "![[assets/deep.jpg]]")),
        "Ideas/assets/deep.jpg"
    );
    assert_eq!(
        found_path(resolved("n.md", "![[One/same.png]]")),
        "One/same.png"
    );
    assert_eq!(
        resolved("n.md", "![[same.png]]"),
        ResolvedImage::Ambiguous(vec!["One/same.png".into(), "Two/same.png".into()])
    );
    assert_eq!(
        resolved("n.md", "![[nope.png]]"),
        ResolvedImage::Missing("nope.png".into())
    );
}

#[test]
fn paths_that_leave_the_project_or_name_a_hidden_place_are_refused() {
    for text in [
        "![a](../../x.png)",
        "![a](../../../Windows/x.png)",
        "![a](.liurium/x.png)",
        "![a](.git/x.png)",
        "![a](.hidden/x.png)",
        "![a](node_modules/x.png)",
        "![a](/x.png)",
        "![a](//server/share/x.png)",
        "![[.liurium/x.png]]",
        "![[../x.png]]",
        "![[node_modules/x.png]]",
    ] {
        let result = resolved("Ideas/n.md", text);
        assert!(
            matches!(result, ResolvedImage::Refused),
            "{text}: {result:?}"
        );
    }
}

#[test]
fn an_address_holds_the_project_and_the_stamp_and_is_encoded() {
    let image = set().listed("GRÖSSE 1.PNG").cloned();
    // Without case by Unicode's rules: `ß` has no such capital, so this one is not found.
    assert_eq!(image, None);
    let image = set().listed("größe 1.png").cloned().expect("listed");
    assert_eq!(
        image.address("p 1"),
        "http://liurium-image.localhost/p%201/Gr%C3%B6%C3%9Fe%201.png?v=1000000000-7"
    );
    let other = KnownImage {
        path: "a/b#c?.png".into(),
        stamp: image.stamp,
    };
    assert!(other.address("p").contains("/p/a/b%23c%3F.png?v="));
}
