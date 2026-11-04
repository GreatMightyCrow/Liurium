//! The TypeScript types in `src/lib/ipc/bindings` are generated from the Rust types
//! (ts-rs, ADR-0018). This test fails when the files differ from what the Rust types
//! produce. With `UPDATE_BINDINGS` set, it rewrites them instead.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use ts_rs::{Config, TS};

use super::data::AppDataInfo;
use super::notes::{NoteEntry, NotesView, SkippedNotes};
use super::projects::{AddOutcome, CurrentProject, ProjectEntry, ProjectInfo, ProjectStatus};
use super::settings::SettingsView;
use super::{AppInfo, CommandError, DataStatus};
use crate::domain::settings::{SettingKey, Settings, StartWith, Zoom};
use crate::domain::sync::SyncTool;
use crate::frame::FrameStyle;
use crate::theme::{Mode, ThemeChoice};

fn output<T: TS + 'static>(config: &Config) -> (PathBuf, String) {
    (
        T::output_path().expect("`export_to` is set"),
        T::export_to_string(config).expect("exportable type"),
    )
}

#[test]
fn typescript_bindings_match_the_rust_types() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/ipc/bindings");
    let config = Config::new();
    let expected = [
        output::<AppInfo>(&config),
        output::<DataStatus>(&config),
        output::<CommandError>(&config),
        output::<SyncTool>(&config),
        output::<ProjectInfo>(&config),
        output::<AddOutcome>(&config),
        output::<CurrentProject>(&config),
        output::<ProjectStatus>(&config),
        output::<ProjectEntry>(&config),
        output::<ThemeChoice>(&config),
        output::<Mode>(&config),
        output::<FrameStyle>(&config),
        output::<Settings>(&config),
        output::<SettingKey>(&config),
        output::<SettingsView>(&config),
        output::<StartWith>(&config),
        output::<Zoom>(&config),
        output::<AppDataInfo>(&config),
        output::<NoteEntry>(&config),
        output::<SkippedNotes>(&config),
        output::<NotesView>(&config),
    ];
    let update = std::env::var_os("UPDATE_BINDINGS").is_some();

    let mut stale = Vec::new();
    for (name, content) in &expected {
        let path = dir.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
            if update {
                fs::create_dir_all(&dir).expect("bindings folder");
                fs::write(&path, content).expect("write binding");
            } else {
                stale.push(name.clone());
            }
        }
    }
    assert!(
        stale.is_empty(),
        "outdated TypeScript bindings {stale:?}; set UPDATE_BINDINGS=1 and run `cargo test bindings`"
    );

    // A type removed from Rust must not leave its file behind.
    let known: BTreeSet<PathBuf> = expected.into_iter().map(|(name, _)| name).collect();
    let present: BTreeSet<PathBuf> = fs::read_dir(&dir)
        .expect("bindings folder")
        .map(|entry| PathBuf::from(entry.expect("entry").file_name()))
        .collect();
    assert_eq!(present, known, "files in {}", dir.display());
}
