use std::{fs, path::PathBuf, time::Instant};

use tempfile::TempDir;

use super::backlinks::refresh_notes;
use super::search::{MAX_RESULTS, search, words};
use super::*;
use crate::storage::db::{CACHE_DIR, open_cache};
use crate::test_support::temp_dir;

const ID: &str = "0b7e2c55-3f1a-4d6b-9c8e-2a1f4e5d6c7b";

struct Fixture {
    dir: TempDir,
    project: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = temp_dir();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir(dir.path().join("app")).expect("app data");
        Self { dir, project }
    }

    fn app(&self) -> PathBuf {
        self.dir.path().join("app")
    }

    fn root(&self) -> ProjectRoot {
        ProjectRoot::open(&self.project).expect("root")
    }

    fn file(&self, rel: &str, text: &str) {
        let path = self.project.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("folders");
        fs::write(path, text).expect("file");
    }

    fn refresh(&self) -> Index {
        refresh(&self.app(), ID, &self.root()).expect("refresh")
    }

    fn hits(&self, query: &str) -> Vec<search::Hit> {
        let cache = open_cache(&self.app(), ID).expect("cache");
        search(&cache.connection, &self.root(), query).expect("search")
    }

    fn found(&self, query: &str) -> Vec<String> {
        self.hits(query).into_iter().map(|hit| hit.path).collect()
    }
}

#[test]
fn each_part_of_a_note_is_found() {
    let f = Fixture::new();
    f.file("Roadmap.md", "nothing here");
    f.file("a.md", "---\naliases: [Wegweiser]\n---\ntext");
    f.file("b.md", "# Zielbild\n\ntext");
    f.file("c.md", "text #kompass");
    f.file("d.md", "---\nstatus: lieferbar\n---\ntext");
    f.file("e.md", "Hier steht das Fernrohr.");
    f.refresh();

    assert_eq!(f.found("roadmap"), ["Roadmap.md"]);
    assert_eq!(f.found("wegweiser"), ["a.md"]);
    assert_eq!(f.found("zielbild"), ["b.md"]);
    assert_eq!(f.found("kompass"), ["c.md"]);
    assert_eq!(f.found("lieferbar"), ["d.md"]);
    assert_eq!(f.found("fernrohr"), ["e.md"]);
    assert!(f.found("nirgendwo").is_empty());
}

#[test]
fn a_name_ranks_above_text() {
    let f = Fixture::new();
    f.file(
        "Notes/Other.md",
        "Planung Planung Planung, der Plan steht im Plan.",
    );
    f.file("Aufbauplan.md", "kein Treffer im Text");
    f.file("Plan.md", "kurz");
    f.refresh();

    // The shorter name first, though it comes later in the alphabet.
    assert_eq!(
        f.found("plan"),
        ["Plan.md", "Aufbauplan.md", "Notes/Other.md"]
    );
}

#[test]
fn parts_of_words_without_case_or_accents() {
    let f = Fixture::new();
    f.file("a.md", "Der Projektplan steht.");
    f.file("b.md", "ÜBER die Brücke");
    f.refresh();

    assert_eq!(f.found("plan"), ["a.md"]);
    assert_eq!(f.found("PROJEKT"), ["a.md"]);
    assert_eq!(f.found("über"), ["b.md"]);
    assert_eq!(f.found("uber"), ["b.md"]);
    assert_eq!(f.found("brucke"), ["b.md"]);
}

#[test]
fn every_word_must_match() {
    let f = Fixture::new();
    f.file("a.md", "Milch und Brot");
    f.file("b.md", "Milch und Käse");
    f.refresh();

    assert_eq!(f.found("milch käse"), ["b.md"]);
    assert_eq!(f.found("käse milch"), ["b.md"]);
    assert_eq!(f.found("milch").len(), 2);
}

#[test]
fn a_short_alias_is_found_by_name() {
    let f = Fixture::new();
    f.file(
        "Kuenstliche Intelligenz.md",
        "---
aliases: [KI]
---
text",
    );
    f.file("other.md", "ki ki");
    f.refresh();

    assert_eq!(f.found("ki"), ["Kuenstliche Intelligenz.md"]);
}

#[test]
fn short_words_find_names_only() {
    let f = Fixture::new();
    f.file("Go.md", "text");
    f.file("other.md", "go go go");
    f.refresh();

    assert_eq!(f.found("go"), ["Go.md"]);
    // A long word searches the text too; the short one only counts for names.
    assert_eq!(f.found("go text"), ["Go.md"]);
}

#[test]
fn the_excerpt_is_the_line_of_the_first_match() {
    let f = Fixture::new();
    f.file(
        "a.md",
        "---\nstatus: Fernrohr\n---\nErste Zeile\r\nIm Garten steht das FERNROHR bereit.\n",
    );
    f.file("Fernglas.md", "nichts davon im Text");
    f.refresh();

    let hits = f.hits("fernrohr");
    assert_eq!(hits.len(), 1);
    let excerpt = hits[0].excerpt.clone().expect("excerpt");
    assert_eq!(excerpt.line, "Im Garten steht das FERNROHR bereit.");
    let units: Vec<u16> = excerpt.line.encode_utf16().collect();
    assert_eq!(
        String::from_utf16_lossy(&units[excerpt.from..excerpt.to]),
        "FERNROHR"
    );
    // Only the name matches: nothing to show from the text.
    let by_name = f.hits("fernglas");
    assert_eq!(by_name[0].path, "Fernglas.md");
    assert_eq!(by_name[0].excerpt, None);
}

#[test]
fn an_excerpt_finds_its_word_with_accents_too() {
    let f = Fixture::new();
    f.file("a.md", "😀 Die Brücke ist lang");
    f.refresh();

    let excerpt = f.hits("brucke")[0].excerpt.clone().expect("excerpt");
    let units: Vec<u16> = excerpt.line.encode_utf16().collect();
    assert_eq!(
        String::from_utf16_lossy(&units[excerpt.from..excerpt.to]),
        "Brücke"
    );
}

#[test]
fn the_index_keeps_no_copy_of_the_text() {
    let f = Fixture::new();
    f.file("a.md", "geheimer Satz");
    f.refresh();

    let cache = open_cache(&f.app(), ID).expect("cache");
    let stored: Option<String> = cache
        .connection
        .query_row("SELECT body FROM search", [], |row| row.get(0))
        .expect("row");
    assert_eq!(stored, None);
}

#[test]
fn a_rebuilt_index_gives_the_same_results() {
    let f = Fixture::new();
    f.file("Plan.md", "Ziele");
    f.file("x/y.md", "Der Plan, die Ziele");
    f.refresh();
    let before = (f.found("plan"), f.found("ziele"));
    fs::remove_dir_all(f.app().join(CACHE_DIR)).expect("delete cache");

    assert!(f.refresh().rebuilt);

    assert_eq!((f.found("plan"), f.found("ziele")), before);
}

#[test]
fn changes_outside_are_found_after_the_next_walk() {
    let f = Fixture::new();
    f.file("a.md", "alter Inhalt");
    f.file("b.md", "bleibt");
    f.file("c.md", "verschwindet bald");
    f.refresh();

    f.file("a.md", "neuer Inhalt, deutlich anders");
    fs::rename(f.project.join("b.md"), f.project.join("umbenannt.md")).expect("rename");
    fs::remove_file(f.project.join("c.md")).expect("delete");
    f.refresh();

    assert!(f.found("alter").is_empty());
    assert_eq!(f.found("deutlich"), ["a.md"]);
    assert_eq!(f.found("bleibt"), ["umbenannt.md"]);
    assert!(f.found("verschwindet").is_empty());
}

#[test]
fn a_note_saved_in_liurium_is_found_at_once() {
    let f = Fixture::new();
    f.file("a.md", "vorher");
    f.file("gone.md", "weg damit");
    f.refresh();
    f.file("a.md", "nachher");
    fs::remove_file(f.project.join("gone.md")).expect("delete");

    let mut cache = open_cache(&f.app(), ID).expect("cache");
    let saved = [
        RelPath::parse("a.md").expect("path"),
        RelPath::parse("gone.md").expect("path"),
    ];
    refresh_notes(&mut cache.connection, &f.root(), &saved).expect("refresh notes");
    drop(cache);

    assert!(f.found("vorher").is_empty());
    assert_eq!(f.found("nachher"), ["a.md"]);
    assert!(f.found("damit").is_empty());
}

#[test]
fn a_note_that_cannot_be_read_is_found_by_name() {
    let f = Fixture::new();
    fs::write(f.project.join("Kaputt.md"), [0xff, 0xfe, 0x00, b'x']).expect("file");
    f.refresh();

    assert_eq!(f.found("kaputt"), ["Kaputt.md"]);
}

#[test]
fn hostile_input_gives_results_or_nothing_never_an_error() {
    let f = Fixture::new();
    f.file(
        "a.md",
        "Ein \"Zitat\" mit NEAR und * und ^ und col:umn (Klammer)",
    );
    f.refresh();
    let huge = "x".repeat(10_000);
    let cases = [
        "\"",
        "\"Zitat",
        "NEAR(Zitat Klammer)",
        "Zit*",
        "^Ein",
        "col:umn",
        "AND OR NOT",
        "(((",
        "-Zitat",
        "\0\u{1}Zitat\u{7f}",
        "",
        "   ",
        "😀😀😀",
        "*",
        huge.as_str(),
    ];
    for query in cases {
        let cache = open_cache(&f.app(), ID).expect("cache");
        assert!(
            search(&cache.connection, &f.root(), query).is_ok(),
            "{query:?} must not fail"
        );
    }
    assert_eq!(f.found("\"Zitat"), ["a.md"]);
    assert_eq!(f.found("col:umn"), ["a.md"]);
    // Read as text: "near(zitat" is not in the note, "near" is.
    assert!(f.found("NEAR(Zitat").is_empty());
    assert_eq!(f.found("NEAR"), ["a.md"]);
}

#[test]
fn input_is_cut_and_cleaned() {
    assert_eq!(words("  Plan\tplan\nPLAN  ziel "), ["Plan", "ziel"]);
    assert_eq!(words("a\u{0}b"), ["a", "b"]);
    assert_eq!(words(&"y".repeat(500))[0].chars().count(), 200);
}

#[test]
fn at_most_fifty_notes_come_back() {
    let f = Fixture::new();
    // More names match than may come back; the text search has its own limit.
    for n in 0..60 {
        f.file(&format!("gemeinsam {n:02}.md"), "x");
    }
    for n in 0..30 {
        f.file(&format!("{n:02}.md"), "gemeinsam");
    }
    f.refresh();

    assert_eq!(f.found("gemeinsam").len(), MAX_RESULTS);
}

/// Timing on a made-up large project; run by hand with
/// `cargo test --release large_project -- --ignored --nocapture`.
#[test]
#[ignore = "timing, run by hand"]
fn large_project_timing() {
    let f = Fixture::new();
    let words = [
        "Projekt",
        "Liurium",
        "Planung",
        "Straße",
        "über",
        "Notiz",
        "Aufgabe",
        "Suche",
        "Graph",
        "Dashboard",
        "Kanban",
        "Rust",
        "Tauri",
        "Fenster",
        "Datei",
        "Brücke",
        "Termin",
        "Idee",
    ];
    for n in 0..5000_usize {
        let text: Vec<&str> = (0..400)
            .map(|i| words[(n * 7 + i * 13 + i / 5) % words.len()])
            .collect();
        f.file(
            &format!("notes/{:02}/{n:04}.md", n % 50),
            &format!("# Notiz {n}\n\n{}", text.join(" ")),
        );
    }
    let start = Instant::now();
    f.refresh();
    let walk = start.elapsed();
    let size = fs::metadata(f.app().join(CACHE_DIR).join(format!("{ID}.db")))
        .map(|meta| meta.len())
        .unwrap_or(0);
    for query in ["planung", "brücke termin", "notiz 4711", "xyz"] {
        let start = Instant::now();
        let hits = f.hits(query);
        println!(
            "{query:<16} {:>4} hits in {:?}",
            hits.len(),
            start.elapsed()
        );
    }
    println!("first walk with index: {walk:?}; cache file {size} bytes");
    let start = Instant::now();
    let cache = open_cache(&f.app(), ID).expect("cache");
    println!("opening the cache: {:?}", start.elapsed());
    for query in ["planung", "xyz"] {
        let start = Instant::now();
        let hits = search(&cache.connection, &f.root(), query).expect("search");
        println!(
            "{query:<16} {:>4} hits in {:?} with the cache open",
            hits.len(),
            start.elapsed()
        );
    }
}

#[test]
fn a_heading_ranks_above_text() {
    let f = Fixture::new();
    f.file(
        "a.md",
        "Leuchtturm im Text, Leuchtturm noch einmal, Leuchtturm.",
    );
    f.file("b.md", "# Leuchtturm\n\nanderer Text");
    f.refresh();

    assert_eq!(f.found("leuchtturm"), ["b.md", "a.md"]);
}

/// The index has exactly one row per note: a row left behind would lend its words to
/// the next note that gets its row id.
fn rows_match_notes(f: &Fixture) {
    let cache = open_cache(&f.app(), ID).expect("cache");
    let count = |sql: &str| -> i64 {
        cache
            .connection
            .query_row(sql, [], |row| row.get(0))
            .expect("count")
    };
    assert_eq!(
        count("SELECT count(*) FROM search_docsize"),
        count("SELECT count(*) FROM notes")
    );
}

#[test]
fn a_deleted_note_leaves_no_words_behind() {
    let f = Fixture::new();
    f.file("a.md", "eins");
    f.file("z.md", "Zitronenbaum");
    f.refresh();
    fs::remove_file(f.project.join("z.md")).expect("delete");
    f.refresh();
    rows_match_notes(&f);
    // The new note gets the deleted one's row id.
    f.file("neu.md", "anderes");
    f.refresh();

    assert!(f.found("zitronenbaum").is_empty());
    rows_match_notes(&f);
}

#[test]
fn a_note_deleted_and_saved_in_liurium_leaves_no_words_behind() {
    let f = Fixture::new();
    f.file("a.md", "eins");
    f.file("z.md", "Zitronenbaum");
    f.refresh();
    fs::remove_file(f.project.join("z.md")).expect("delete");
    let mut cache = open_cache(&f.app(), ID).expect("cache");
    refresh_notes(
        &mut cache.connection,
        &f.root(),
        &[RelPath::parse("z.md").expect("path")],
    )
    .expect("refresh notes");
    drop(cache);

    rows_match_notes(&f);
}
