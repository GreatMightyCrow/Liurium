use std::{fs, path::Path};

use tempfile::TempDir;

use crate::commands::tests::{added, workspace};
use crate::storage::db::Kind;
use crate::test_support::{current, project as fixture, temp_dir};

use super::*;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

fn write(folder: &Path, name: &str, bytes: &[u8]) {
    let path = folder.join(name);
    fs::create_dir_all(path.parent().expect("parent")).expect("folder");
    fs::write(path, bytes).expect("file");
}

/// The open project holding these files, walked; and its folder and id.
fn project(files: &[(&str, &[u8])]) -> (TempDir, Workspace, std::path::PathBuf, String) {
    let dir = temp_dir();
    let garden = fixture(dir.path(), "Garden", current(Kind::Project));
    for (name, bytes) in files {
        write(&garden.root, name, bytes);
    }
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &garden.root);
    workspace.notes().expect("walked");
    (dir, workspace, garden.root, garden.id)
}

#[test]
fn image_types_come_from_the_first_bytes() {
    assert_eq!(image_type(PNG), Some("image/png"));
    assert_eq!(image_type(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
    assert_eq!(image_type(b"GIF89a"), Some("image/gif"));
    assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
    let mut bmp = b"BM".to_vec();
    bmp.resize(14, 0);
    bmp.extend(40_u32.to_le_bytes());
    assert_eq!(image_type(&bmp), Some("image/bmp"));
    assert_eq!(
        image_type(b"\0\0\0\x18ftypavif\0\0\0\0mif1avif"),
        Some("image/avif")
    );
    assert_eq!(
        image_type(b"\0\0\0\x18ftypmif1\0\0\0\0mif1avif"),
        Some("image/avif")
    );
    for not_one in [
        &b""[..],
        b"# A note",
        b"SQLite format 3\0",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>x</script></svg>",
        b"BM is how this text starts",
        b"RIFF\0\0\0\0WAVEfmt ",
        b"\0\0\0\x18ftypisom\0\0\0\0isommp41",
    ] {
        assert_eq!(image_type(not_one), None, "{not_one:?}");
    }
}

#[test]
fn a_listed_image_of_the_open_project_is_served() {
    let (_dir, workspace, _root, id) = project(&[("Ideas/Größe 1.png", PNG)]);
    let (bytes, kind) = workspace
        .image_at(&format!("/{id}/Ideas/Gr%C3%B6%C3%9Fe%201.png"))
        .expect("served");
    assert_eq!(bytes, PNG);
    assert_eq!(kind, "image/png");
}

#[test]
fn everything_else_is_refused() {
    let (_dir, workspace, root, id) = project(&[
        ("pic.png", PNG),
        ("Plan.md", b"# Secret"),
        ("renamed.png", b"# Secret"),
        (".liurium/inside.png", PNG),
        ("node_modules/x.png", PNG),
    ]);
    fs::write(root.join("late.png"), PNG).expect("after the walk");
    let refused = [
        // Another project, or none named.
        "/other/pic.png".to_owned(),
        "/pic.png".to_owned(),
        // Never listed: not an image, hidden, skipped, not there, or not walked yet.
        format!("/{id}/Plan.md"),
        format!("/{id}/.liurium/project.db"),
        format!("/{id}/.liurium/inside.png"),
        format!("/{id}/node_modules/x.png"),
        format!("/{id}/missing.png"),
        format!("/{id}/late.png"),
        // Ways out of the project.
        format!("/{id}/../pic.png"),
        format!("/{id}/..%2F..%2Fpic.png"),
        format!("/{id}/%2E%2E/pic.png"),
        format!("/{id}/C:/Windows/win.ini"),
        format!("/{id}/broken%ZZ.png"),
        // Named as an image, but its bytes are none.
        format!("/{id}/renamed.png"),
    ];
    for path in refused {
        assert_eq!(workspace.image_at(&path), None, "{path}");
    }
    assert!(workspace.image_at(&format!("/{id}/pic.png")).is_some());
}

#[test]
fn another_method_and_a_refusal_say_nothing() {
    let (_dir, workspace, _root, id) = project(&[("pic.png", PNG)]);
    let path = format!("/{id}/pic.png");
    let served = workspace.image_response(&Method::GET, &path);
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(served.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(served.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(served.headers()[header::CACHE_CONTROL], "no-store");
    let posted = workspace.image_response(&Method::POST, &path);
    assert_eq!(posted.status(), StatusCode::NOT_FOUND);
    assert!(posted.body().is_empty());
    let refused = workspace.image_response(&Method::GET, &format!("/{id}/nope.png"));
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
    assert!(refused.body().is_empty());
    assert_eq!(refused.headers().get(header::CONTENT_TYPE), None);
}

#[test]
fn a_file_above_the_limit_is_not_served() {
    let (_dir, workspace, root, id) = project(&[("big.png", PNG)]);
    let file = fs::OpenOptions::new()
        .write(true)
        .open(root.join("big.png"))
        .expect("file");
    file.set_len(MAX_IMAGE_BYTES + 1).expect("sparse");
    assert_eq!(workspace.image_at(&format!("/{id}/big.png")), None);
}

#[test]
fn a_changed_image_makes_a_new_list_and_a_new_address() {
    let (dir, workspace, folder, id) = project(&[("pic.png", PNG)]);
    let before = workspace.note_index().image_set(&id).expect("set");
    let old = before.listed("pic.png").expect("listed").address(&id);
    let rescan = || {
        let root = crate::storage::fs::ProjectRoot::open(&folder).expect("root");
        workspace
            .note_index()
            .rescan(&dir.path().join("app"), &id, &root, None)
    };
    assert!(!rescan(), "nothing changed");
    let mut longer = PNG.to_vec();
    longer.push(0);
    fs::write(folder.join("pic.png"), longer).expect("changed");
    assert!(rescan(), "the list reports the change");
    let after = workspace.note_index().image_set(&id).expect("set");
    assert_ne!(after.listed("pic.png").expect("listed").address(&id), old);
}
