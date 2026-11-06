//! Finding notes in real temp folders (M3-002). Junction tests run everywhere;
//! symbolic link tests need the right to create them and run in CI (M2-003 D3).

use std::{ffi::OsString, os::windows::ffi::OsStringExt};

use tempfile::TempDir;

use super::*;
use crate::test_support::{TreeSnapshot, junction, temp_dir};

struct Fixture {
    _dir: TempDir,
    project: PathBuf,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let dir = temp_dir();
    let project = dir.path().join("project");
    let outside = dir.path().join("outside");
    fs::create_dir(&project).expect("project folder");
    fs::create_dir(&outside).expect("outside folder");
    Fixture {
        _dir: dir,
        project,
        outside,
    }
}

impl Fixture {
    fn file(&self, rel: &str) {
        let path = self.project.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("folders");
        fs::write(&path, rel.as_bytes()).expect("file");
    }

    fn walk(&self) -> Walk {
        self.walk_with(Limits::DEFAULT)
    }

    fn walk_with(&self, limits: Limits) -> Walk {
        ProjectRoot::open(&self.project)
            .expect("root")
            .find_notes(limits)
    }
}

fn paths(walk: &Walk) -> Vec<String> {
    walk.notes
        .iter()
        .map(|note| note.path.to_string())
        .collect()
}

/// A path with the `\\?\` prefix, which lets Windows create names its own rules
/// refuse.
fn verbatim(path: &Path) -> PathBuf {
    let mut text = OsString::from(r"\\?\");
    text.push(path.as_os_str());
    PathBuf::from(text)
}

#[test]
fn md_and_markdown_files_count_in_any_case_sorted_by_path() {
    let f = fixture();
    for rel in [
        "b.md",
        "A.MD",
        "c.markdown",
        "notes/x.Md",
        "Notes2/y.md",
        "plain.txt",
        "component.mdx",
        "README",
        "md",
        ".hidden.md",
    ] {
        f.file(rel);
    }

    let walk = f.walk();

    assert_eq!(
        paths(&walk),
        ["A.MD", "b.md", "c.markdown", "notes/x.Md", "Notes2/y.md"]
    );
    assert_eq!(walk.skipped, Skipped::default());
    assert!(!walk.truncated);
}

#[test]
fn dot_folders_and_build_folders_are_skipped_in_any_case() {
    let f = fixture();
    for rel in [
        ".git/a.md",
        ".liurium/a.md",
        ".obsidian/a.md",
        ".trash/a.md",
        "node_modules/pkg/README.md",
        "Target/a.md",
        "dist/a.md",
        "BUILD/a.md",
        "out/a.md",
        "vendor/a.md",
        "__pycache__/a.md",
        "docs/node_modules/a.md",
        "builds/kept.md",
        "my.target/kept.md",
        "docs/out.md",
    ] {
        f.file(rel);
    }

    assert_eq!(
        paths(&f.walk()),
        ["builds/kept.md", "docs/out.md", "my.target/kept.md"]
    );
}

#[test]
fn stamps_are_the_files_size_and_modified_time() {
    let f = fixture();
    f.file("notes/idea.md");

    let walk = f.walk();

    let metadata = fs::metadata(f.project.join("notes/idea.md")).expect("metadata");
    assert_eq!(walk.notes[0].stamp, Stamp::of(&metadata).expect("stamp"));
    assert_eq!(walk.notes[0].stamp.len, "notes/idea.md".len() as u64);
}

#[test]
fn the_walk_writes_nothing() {
    let f = fixture();
    f.file("a.md");
    f.file("notes/b.md");
    junction(&f.project.join("alias"), &f.project.join("notes"));
    let before = TreeSnapshot::of(&f.project);

    f.walk();

    before.assert_unchanged(&f.project);
}

#[test]
fn a_junction_to_a_walked_folder_adds_nothing_twice() {
    let f = fixture();
    f.file("notes/a.md");
    junction(&f.project.join("alias"), &f.project.join("notes"));
    junction(&f.project.join("Notes Again"), &f.project.join("NOTES"));

    let walk = f.walk();

    assert_eq!(paths(&walk), ["notes/a.md"]);
    assert_eq!(walk.skipped, Skipped::default());
}

#[test]
fn a_junction_to_a_skipped_folder_inside_is_followed_once() {
    let f = fixture();
    f.file("node_modules/pkg/README.md");
    junction(
        &f.project.join("docs"),
        &f.project.join("node_modules").join("pkg"),
    );
    junction(
        &f.project.join("more docs"),
        &f.project.join("node_modules").join("pkg"),
    );

    assert_eq!(paths(&f.walk()), ["docs/README.md"]);
}

#[test]
fn junction_loops_end() {
    let f = fixture();
    f.file("notes/a.md");
    junction(&f.project.join("notes").join("up"), &f.project);
    junction(
        &f.project.join("notes").join("self"),
        &f.project.join("notes"),
    );

    let walk = f.walk();

    assert_eq!(paths(&walk), ["notes/a.md"]);
    assert_eq!(walk.skipped, Skipped::default());
}

#[test]
fn junctions_out_of_the_project_or_into_its_own_folders_are_skipped() {
    let f = fixture();
    fs::write(f.outside.join("secret.md"), b"secret").expect("file");
    f.file(".liurium/x.md");
    f.file(".git/y.md");
    junction(&f.project.join("escape"), &f.outside);
    junction(&f.project.join("meta"), &f.project.join(".liurium"));
    junction(&f.project.join("history"), &f.project.join(".git"));

    let walk = f.walk();

    assert!(walk.notes.is_empty(), "{:?}", paths(&walk));
    assert_eq!(walk.skipped.links_outside, 3);
}

#[test]
fn a_junction_to_a_missing_folder_is_counted_as_broken() {
    let f = fixture();
    let gone = f.outside.join("gone");
    fs::create_dir(&gone).expect("folder");
    junction(&f.project.join("dangling"), &gone);
    fs::remove_dir(&gone).expect("remove target");

    let walk = f.walk();

    assert!(walk.notes.is_empty());
    assert_eq!(walk.skipped.broken_links, 1);
}

#[test]
fn names_windows_rules_refuse_are_skipped_and_counted() {
    let f = fixture();
    f.file("good.md");
    fs::write(verbatim(&f.project.join("CON.md")), b"x").expect("reserved name");
    fs::create_dir(verbatim(&f.project.join("folder."))).expect("trailing dot");
    fs::write(verbatim(&f.project.join("folder.").join("inner.md")), b"x").expect("file");
    // An unpaired surrogate: a valid Windows name, but not valid Unicode.
    let mut odd = OsString::from_wide(&[0xD800]);
    odd.push(".md");
    fs::write(f.project.join(odd), b"x").expect("odd name");

    let walk = f.walk();

    assert_eq!(paths(&walk), ["good.md"]);
    assert_eq!(walk.skipped.bad_names, 3);
}

#[test]
fn the_walk_stops_at_the_note_limit() {
    let f = fixture();
    for name in ["a.md", "b.md", "c.md", "d.md", "e.md"] {
        f.file(name);
    }

    let walk = f.walk_with(Limits {
        notes: 3,
        depth: 64,
    });

    assert_eq!(walk.notes.len(), 3);
    assert!(walk.truncated);
}

#[test]
fn folders_below_the_depth_limit_are_skipped_and_counted() {
    let f = fixture();
    f.file("a/one.md");
    f.file("a/b/two.md");
    f.file("a/b/c/three.md");
    f.file("a/b/c/d/four.md");

    let walk = f.walk_with(Limits {
        notes: 100,
        depth: 2,
    });

    assert_eq!(paths(&walk), ["a/b/two.md", "a/one.md"]);
    assert_eq!(walk.skipped.too_deep, 1);
}

#[test]
fn a_missing_root_folder_gives_an_unreadable_count_not_a_panic() {
    let f = fixture();
    let root = ProjectRoot::open(&f.project).expect("root");
    fs::remove_dir(&f.project).expect("remove");

    let walk = root.find_notes(Limits::DEFAULT);

    assert!(walk.notes.is_empty());
    assert_eq!(walk.skipped.unreadable, 1);
}

#[test]
#[ignore = "needs the right to create symbolic links; runs in CI"]
fn symbolic_links_follow_the_same_rules_as_junctions() {
    use std::os::windows::fs::{symlink_dir, symlink_file};

    let f = fixture();
    f.file("notes/real.md");
    f.file("node_modules/pkg/README.md");
    fs::write(f.outside.join("secret.md"), b"secret").expect("file");
    symlink_file(f.project.join("notes/real.md"), f.project.join("again.md")).expect("link");
    symlink_file(f.outside.join("secret.md"), f.project.join("secret.md")).expect("link");
    symlink_file(f.project.join("missing.md"), f.project.join("broken.md")).expect("link");
    symlink_dir(f.project.join("node_modules/pkg"), f.project.join("docs")).expect("link");
    symlink_dir(&f.project, f.project.join("notes/up")).expect("link");
    symlink_dir(&f.outside, f.project.join("escape")).expect("link");

    let walk = f.walk();

    assert_eq!(paths(&walk), ["docs/README.md", "notes/real.md"]);
    assert_eq!(walk.skipped.links_outside, 2);
    assert_eq!(walk.skipped.broken_links, 1);
}

#[test]
fn images_are_listed_apart_from_notes_by_the_same_rules() {
    let f = fixture();
    f.file("a.md");
    f.file("pics/One.PNG");
    f.file("pics/two.jpeg");
    for skipped in [
        "pics/.hidden.png",
        ".liurium/x.png",
        ".git/x.png",
        "node_modules/x.png",
        "target/x.webp",
        "pics/x.svg",
        "pics/x.pdf",
    ] {
        f.file(skipped);
    }

    let walk = f.walk();

    assert_eq!(paths(&walk), ["a.md"]);
    let images: Vec<String> = walk.images.iter().map(|i| i.path.to_string()).collect();
    assert_eq!(images, ["pics/One.PNG", "pics/two.jpeg"]);
    assert_eq!(walk.images[0].stamp.len, "pics/One.PNG".len() as u64);
}

#[test]
fn the_note_limit_counts_notes_not_images() {
    let f = fixture();
    f.file("a.png");
    f.file("b.png");
    f.file("c.md");

    let walk = f.walk_with(Limits { notes: 1, depth: 8 });

    assert_eq!(paths(&walk), ["c.md"]);
    assert_eq!(walk.images.len(), 2);
    assert!(!walk.truncated);
}

#[test]
#[ignore = "needs the right to create symbolic links; runs in CI"]
fn an_image_link_follows_the_same_rules_as_a_note_link() {
    use std::os::windows::fs::symlink_file;

    let f = fixture();
    f.file("real.png");
    f.file(".liurium/inside.png");
    fs::write(f.outside.join("secret.png"), b"secret").expect("file");
    symlink_file(f.project.join("real.png"), f.project.join("again.png")).expect("link");
    symlink_file(f.outside.join("secret.png"), f.project.join("out.png")).expect("link");
    symlink_file(
        f.project.join(".liurium/inside.png"),
        f.project.join("db.png"),
    )
    .expect("link");

    let walk = f.walk();

    let images: Vec<String> = walk.images.iter().map(|i| i.path.to_string()).collect();
    assert_eq!(images, ["real.png"], "already found through its real path");
    assert_eq!(walk.skipped.links_outside, 2);
}

#[test]
fn empty_folders_are_reported_but_folders_with_other_files_are_not() {
    let f = fixture();
    fs::create_dir_all(f.project.join("New/Inner")).expect("folders");
    fs::create_dir(f.project.join("Empty")).expect("folder");
    f.file("src/main.rs");
    fs::create_dir(f.project.join(".hidden")).expect("folder");
    fs::create_dir_all(f.project.join("node_modules/empty")).expect("folder");

    let walk = f.walk();

    let empty: Vec<String> = walk.empty_folders.iter().map(ToString::to_string).collect();
    assert_eq!(empty, ["Empty", "New/Inner"]);
}
