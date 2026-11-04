use std::{fs, path::PathBuf};

use tempfile::TempDir;

use super::*;
use crate::domain::notes::refresh;
use crate::storage::db::{self, CACHE_DIR};
use crate::test_support::temp_dir;

const ID: &str = "4b1c0d2e-3f4a-4b5c-8d6e-7f8091a2b3c4";

struct Fixture {
    dir: TempDir,
    project: PathBuf,
    root: ProjectRoot,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Self {
        let dir = temp_dir();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir(dir.path().join("app")).expect("app");
        for (rel, text) in files {
            let path = project.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("folders");
            fs::write(path, text).expect("note");
        }
        let root = ProjectRoot::open(&project).expect("root");
        Self { dir, project, root }
    }

    fn app(&self) -> PathBuf {
        self.dir.path().join("app")
    }

    /// Walks, then asks for the backlinks of `target`.
    fn backlinks(&self, target: &str) -> Vec<BacklinkSource> {
        let index = refresh(&self.app(), ID, &self.root).expect("walk");
        let set = NoteSet::new(index.notes.iter().map(|note| note.path.clone()));
        let cache = db::open_cache(&self.app(), ID).expect("cache");
        backlinks(&cache.connection, &self.root, &set, &rel(target)).expect("backlinks")
    }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

fn sources(found: &[BacklinkSource]) -> Vec<&str> {
    found.iter().map(|source| source.path.as_str()).collect()
}

#[test]
fn every_link_form_that_leads_here_counts_once_per_link() {
    let f = Fixture::new(&[
        ("Ideas/Plan.md", "# Plan\n\n## Next\n"),
        ("Home.md", "See [[Plan]] and [[Plan#Next|next]].\n"),
        ("Work/Report.md", "Back to [plan](../Ideas/Plan.md).\n"),
        ("Archive/Old.md", "[[Ideas/Plan]] once\n"),
        ("Other.md", "[[Home]] only\n"),
        ("Ideas/Self.md", "x\n"),
    ]);

    let found = f.backlinks("Ideas/Plan.md");

    assert_eq!(
        sources(&found),
        ["Archive/Old.md", "Home.md", "Work/Report.md"]
    );
    assert_eq!(found[1].links.len(), 2);
    let first = &found[1].links[0];
    assert_eq!(first.line, "See [[Plan]] and [[Plan#Next|next]].");
    let units: Vec<u16> = first.line.encode_utf16().collect();
    assert_eq!(
        String::from_utf16_lossy(&units[first.from..first.to]),
        "[[Plan]]"
    );
    assert_eq!(first.offset, 4);
}

#[test]
fn a_note_linking_to_itself_and_ambiguous_links_are_left_out() {
    let f = Fixture::new(&[
        ("Plan.md", "Top [[Plan]] [[#Section]]\n"),
        ("A/Dup.md", "a\n"),
        ("B/Dup.md", "b\n"),
        ("Home.md", "[[Dup]] and [[A/Dup]]\n"),
    ]);

    assert!(f.backlinks("Plan.md").is_empty());
    let found = f.backlinks("A/Dup.md");
    assert_eq!(sources(&found), ["Home.md"]);
    assert_eq!(found[0].links.len(), 1, "only the clear [[A/Dup]]");
}

#[test]
fn long_lines_are_shortened_around_the_link_without_breaking_characters() {
    let before = "ä".repeat(100);
    let after = "😀".repeat(100);
    let f = Fixture::new(&[
        ("Plan.md", "plan\n"),
        (
            "Home.md",
            &format!("first line\r\n{before}[[Plan]]{after}\r\nlast\r\n"),
        ),
    ]);

    let link = &f.backlinks("Plan.md")[0].links[0];

    assert!(
        link.line.starts_with('…') && link.line.ends_with('…'),
        "{}",
        link.line
    );
    assert_eq!(link.line.chars().filter(|c| *c == 'ä').count(), 60);
    assert_eq!(link.line.chars().filter(|c| *c == '😀').count(), 60);
    let units: Vec<u16> = link.line.encode_utf16().collect();
    assert_eq!(
        String::from_utf16_lossy(&units[link.from..link.to]),
        "[[Plan]]"
    );
    assert_eq!(link.offset, "first line\r\n".len() + 100);
}

#[test]
fn notes_saved_in_liurium_get_their_links_refreshed_before_asking() {
    let f = Fixture::new(&[("Plan.md", "plan\n"), ("Home.md", "nothing yet\n")]);
    assert!(f.backlinks("Plan.md").is_empty());

    fs::write(f.project.join("Home.md"), "now [[Plan]]\n").expect("edit");
    fs::write(f.project.join("New.md"), "also [[Plan]]\n").expect("new");
    let mut cache = db::open_cache(&f.app(), ID).expect("cache");
    refresh_notes(
        &mut cache.connection,
        &f.root,
        &[rel("Home.md"), rel("New.md"), rel("Gone.md")],
    )
    .expect("refresh");
    let set = NoteSet::new(["Plan.md", "Home.md", "New.md"].map(String::from));

    let found = backlinks(&cache.connection, &f.root, &set, &rel("Plan.md")).expect("backlinks");

    assert_eq!(sources(&found), ["Home.md", "New.md"]);
    assert!(f.app().join(CACHE_DIR).is_dir());
}
