use std::{io, path::PathBuf};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::projects::{AddOutcome, CurrentProject, ProjectInfo, ProjectStatus, Workspace, checked};
use super::settings::SettingsView;
use super::*;
use crate::domain::projects::{ProjectCopy, ProjectError};
use crate::domain::settings::{SettingKey, Settings, StartWith, Zoom};
use crate::domain::sync::{SyncRoot, SyncTool};
use crate::frame::FrameStyle;
use crate::storage::db::Kind;
use crate::storage::fs::{FsError, PathRule};
use crate::test_support::{
    Snapshot, TreeSnapshot, app_data, current, damage, liurium_database, project, temp_dir,
};
use crate::theme::{Mode, ThemeChoice};

fn to_json(value: &impl Serialize) -> Value {
    serde_json::to_value(value).expect("serializable")
}

#[test]
fn errors_cross_ipc_as_a_kind_with_camel_case_fields() {
    assert_eq!(
        to_json(&CommandError::Changed),
        json!({ "kind": "changed" })
    );
    assert_eq!(
        to_json(&CommandError::NewerVersion),
        json!({ "kind": "newerVersion" })
    );
    assert_eq!(
        to_json(&CommandError::TooLarge { max_bytes: 10 }),
        json!({ "kind": "tooLarge", "maxBytes": 10 })
    );
}

#[test]
fn database_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (DbError::Missing, CommandError::NotFound),
        (DbError::NotLiurium, CommandError::Damaged),
        (DbError::Corrupt, CommandError::Damaged),
        (
            DbError::NewerSchema {
                found: 3,
                supported: 1,
            },
            CommandError::NewerVersion,
        ),
        (DbError::Locked, CommandError::Locked),
        (DbError::DiskFull, CommandError::DiskFull),
        (DbError::ReadOnly, CommandError::ReadOnly),
        (
            DbError::Migration {
                version: 2,
                source: rusqlite::Error::InvalidQuery,
            },
            CommandError::UpgradeFailed,
        ),
        (
            DbError::JournalMode {
                wanted: "wal",
                got: "delete".into(),
            },
            CommandError::Internal,
        ),
        (
            DbError::Sqlite(rusqlite::Error::InvalidQuery),
            CommandError::Internal,
        ),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

#[test]
fn file_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (
            FsError::InvalidPath(PathRule::Reserved),
            CommandError::InvalidPath,
        ),
        (FsError::OutsideRoot, CommandError::OutsideProject),
        (FsError::Protected, CommandError::Protected),
        (FsError::BrokenLink, CommandError::BrokenLink),
        (FsError::NotFound, CommandError::NotFound),
        (FsError::WrongKind, CommandError::WrongKind),
        (FsError::AlreadyExists, CommandError::AlreadyExists),
        (FsError::Changed, CommandError::Changed),
        (FsError::ReadOnly, CommandError::ReadOnly),
        (
            FsError::TooLarge { len: 20, max: 10 },
            CommandError::TooLarge { max_bytes: 10 },
        ),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

#[test]
fn operating_system_details_never_cross_ipc() {
    let secret = r"C:\Users\Someone\notes\diary.md: access denied";
    let file = CommandError::from(FsError::Io(io::Error::other(secret)));
    let database = CommandError::from(DbError::Io(io::Error::other(secret)));

    for error in [file, database] {
        assert_eq!(to_json(&error), json!({ "kind": "internal" }));
    }
}

#[test]
fn a_new_app_folder_is_ready() {
    let dir = temp_dir();
    let startup = Startup::open(Some(&dir.path().join("app")));

    assert_eq!(startup.data, DataStatus::Ready);
    assert!(dir.path().join(r"app\app.db").is_file());
}

#[test]
fn a_damaged_app_database_is_reported_as_recovered() {
    let dir = temp_dir();
    let path = dir.path().join("app.db");
    drop(liurium_database(&path, Kind::App, current(Kind::App)));
    damage(&path);

    let startup = Startup::open(Some(dir.path()));

    assert_eq!(startup.data, DataStatus::Recovered);
}

#[test]
fn a_newer_app_database_is_reported_as_failed() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    Connection::open(&path)
        .expect("database")
        .pragma_update(None, "user_version", 9)
        .expect("version");
    let before = Snapshot::of(&path);

    let startup = Startup::open(Some(dir.path()));
    before.assert_unchanged(&path);

    assert_eq!(
        to_json(&startup.data),
        json!({ "state": "failed", "error": { "kind": "newerVersion" } })
    );
}

#[test]
fn a_missing_app_folder_path_is_an_internal_failure() {
    assert_eq!(
        Startup::open(None).data,
        DataStatus::Failed {
            error: CommandError::Internal
        }
    );
}

#[test]
fn app_info_uses_camel_case_names() {
    let info = AppInfo {
        version: "0.1.0".into(),
        data: DataStatus::Recovered,
    };
    assert_eq!(
        to_json(&info),
        json!({ "version": "0.1.0", "data": { "state": "recovered" } })
    );
}

#[test]
fn project_errors_map_to_what_the_user_can_act_on() {
    let cases = [
        (ProjectError::Fs(FsError::ReadOnly), CommandError::ReadOnly),
        (ProjectError::Db(DbError::Locked), CommandError::Locked),
        (ProjectError::Unsuitable, CommandError::UnsuitableFolder),
        (ProjectError::Damaged, CommandError::Damaged),
        (ProjectError::Unknown, CommandError::NotFound),
        (ProjectError::OtherProject, CommandError::OtherProject),
        (
            ProjectError::Duplicate(Box::new(ProjectCopy {
                folder: PathBuf::from(r"C:\Notes - Copy"),
                display: r"C:\Notes - Copy".to_owned(),
                id: "00000000-0000-4000-8000-000000000001".to_owned(),
                original_name: "Notes".to_owned(),
                original_folder: r"C:\Notes".to_owned(),
            })),
            CommandError::DuplicateProject,
        ),
        (ProjectError::Changed, CommandError::Changed),
        (ProjectError::NoProject, CommandError::NoProject),
        (ProjectError::InvalidName, CommandError::InvalidName),
    ];
    for (error, expected) in cases {
        let shown = format!("{error:?}");
        assert_eq!(CommandError::from(error), expected, "{shown}");
    }
}

/// Like the app's start: the stored settings decide whether the last project reopens.
fn workspace(app_dir: &Path) -> Workspace {
    let startup = Startup::open(Some(app_dir));
    Workspace::new(
        Some(app_dir.to_owned()),
        &startup.data,
        Vec::new(),
        startup.settings.settings.startup,
    )
}

/// Adds a folder that is no copy.
#[track_caller]
fn added(workspace: &Workspace, folder: &Path) -> ProjectInfo {
    match workspace.add(folder).expect("added") {
        AddOutcome::Added { project } => project,
        outcome => panic!("{outcome:?}"),
    }
}

#[test]
fn a_first_start_has_no_current_project() {
    let dir = temp_dir();

    let current = workspace(&dir.path().join("app"))
        .current()
        .expect("current");

    assert_eq!(to_json(&current), json!({ "state": "none" }));
}

#[test]
fn the_added_project_opens_again_after_a_restart() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    let added = added(&workspace(&app_dir), &fixture.root);

    let restarted = workspace(&app_dir).current().expect("current");

    assert_eq!(added.id, fixture.id);
    assert_eq!(
        restarted,
        CurrentProject::Open {
            project: added.clone()
        }
    );
    // The long path without `\\?\`: CI's temp folder is a short 8.3 name.
    let long = std::fs::canonicalize(&fixture.root).expect("folder");
    assert_eq!(
        to_json(&added)["folder"],
        json!(long.to_string_lossy().trim_start_matches(r"\\?\"))
    );
    assert_eq!(to_json(&added)["readOnly"], json!(false));
}

#[test]
fn a_project_that_cannot_be_reopened_is_named_with_the_reason() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    added(&workspace(&app_dir), &fixture.root);
    std::fs::remove_dir_all(&fixture.root).expect("folder gone");

    let restarted = workspace(&app_dir).current().expect("current");

    assert_eq!(
        to_json(&restarted),
        json!({
            "state": "unavailable",
            "id": fixture.id,
            "name": "Garden",
            "error": { "kind": "notFound" }
        })
    );
}

fn statuses(workspace: &Workspace) -> Vec<(String, ProjectStatus)> {
    workspace
        .list()
        .expect("list")
        .into_iter()
        .map(|entry| (entry.name, entry.status))
        .collect()
}

#[test]
fn the_list_marks_the_open_and_the_missing_projects() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    // Names in the same order as the opening times, which can share a millisecond.
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let notes = project(dir.path(), "Notes", current(Kind::Project));
    let old = project(dir.path(), "Old", current(Kind::Project));
    let workspace = workspace(&app_dir);
    for fixture in [&old, &notes, &garden] {
        added(&workspace, &fixture.root);
    }
    std::fs::rename(&old.root, dir.path().join("Moved")).expect("move");

    // A fresh workspace, as after a restart, that lists before anything else.
    let restarted = statuses(&self::workspace(&app_dir));

    assert_eq!(
        restarted,
        [
            ("Garden".to_owned(), ProjectStatus::Open),
            ("Notes".to_owned(), ProjectStatus::Available),
            ("Old".to_owned(), ProjectStatus::Missing),
        ]
    );
    let entry = &workspace.list().expect("list")[0];
    assert_eq!(
        to_json(entry)
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>()),
        Some(vec![
            "folder".to_owned(),
            "id".to_owned(),
            "lastOpenedAt".to_owned(),
            "name".to_owned(),
            "status".to_owned()
        ])
    );
    assert_eq!(to_json(&entry.status), json!("open"));
}

#[test]
fn opening_another_project_makes_it_the_open_one() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    added(&workspace, &garden.root);
    added(&workspace, &work.root);

    let opened = workspace.open(&garden.id).expect("opened");

    assert_eq!(opened.name, "Garden");
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: opened }
    );
    assert_eq!(
        statuses(&workspace)[0],
        ("Garden".to_owned(), ProjectStatus::Open)
    );
}

#[test]
fn a_project_that_fails_to_open_leaves_the_open_one_open() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    added(&workspace, &garden.root);
    let open = added(&workspace, &work.root);
    std::fs::remove_dir_all(&garden.root).expect("gone");

    assert_eq!(workspace.open(&garden.id), Err(CommandError::NotFound));
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: open }
    );
}

#[test]
fn renaming_the_open_project_updates_what_the_page_is_shown() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    added(&workspace, &work.root);
    added(&workspace, &garden.root);

    workspace
        .rename(&garden.id, "Kitchen")
        .expect("renamed open");
    workspace
        .rename(&work.id, "Office")
        .expect("renamed closed");

    let CurrentProject::Open { project } = workspace.current().expect("current") else {
        panic!("a project is open");
    };
    assert_eq!(project.name, "Kitchen");
    assert_eq!(
        statuses(&workspace),
        [
            ("Kitchen".to_owned(), ProjectStatus::Open),
            ("Office".to_owned(), ProjectStatus::Available)
        ]
    );
    assert_eq!(
        workspace.rename(&work.id, " "),
        Err(CommandError::InvalidName)
    );
}

#[test]
fn removing_the_open_project_closes_it_and_keeps_its_folder() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    let workspace = workspace(&app_dir);
    added(&workspace, &work.root);
    added(&workspace, &garden.root);

    workspace.remove(&work.id).expect("removed closed");
    assert!(matches!(
        workspace.current().expect("current"),
        CurrentProject::Open { .. }
    ));
    let before = TreeSnapshot::of(&garden.root);
    workspace.remove(&garden.id).expect("removed open");

    assert_eq!(workspace.current().expect("current"), CurrentProject::None);
    assert!(workspace.list().expect("list").is_empty());
    before.assert_unchanged(&garden.root);
    assert_eq!(workspace.remove(&garden.id), Err(CommandError::NotFound));
}

#[test]
fn a_located_project_becomes_the_open_one() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    added(&workspace(&app_dir), &garden.root);
    let moved = dir.path().join("Moved");
    std::fs::rename(&garden.root, &moved).expect("move");
    let workspace = workspace(&app_dir);
    assert!(matches!(
        workspace.current().expect("current"),
        CurrentProject::Unavailable { .. }
    ));

    let located = workspace.locate(&garden.id, &moved).expect("located");

    assert_eq!(located.id, garden.id);
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: located }
    );
    assert_eq!(
        statuses(&workspace),
        [("Garden".to_owned(), ProjectStatus::Open)]
    );
}

#[test]
fn ids_from_the_page_must_be_project_ids() {
    assert_eq!(
        checked("00000000-0000-4000-8000-000000000001"),
        Ok("00000000-0000-4000-8000-000000000001")
    );
    for bad in [
        "",
        "..",
        r"C:\Users",
        "00000000-0000-4000-8000-00000000000Z",
    ] {
        assert_eq!(checked(bad), Err(CommandError::NotFound), "{bad}");
    }
}

fn stored_settings(app_dir: &Path) -> Settings {
    let conn =
        db::open(&app_dir.join("app.db"), Kind::App, db::OpenMode::Existing).expect("app.db");
    stored::load(&conn).expect("settings").settings
}

const CHOSEN: Settings = Settings {
    theme: ThemeChoice::Mint,
    mode: Mode::Dark,
    frame: FrameStyle::Native,
    startup: StartWith::ProjectList,
    // Other steps: domain/settings/tests.rs; the field stays private to keep them valid.
    zoom: Zoom::DEFAULT,
};

#[test]
fn the_start_reads_the_stored_settings() {
    let dir = temp_dir();
    app_data(dir.path(), &[]);
    stored::save(
        &mut db::open(
            &dir.path().join("app.db"),
            Kind::App,
            db::OpenMode::Existing,
        )
        .expect("app.db"),
        &CHOSEN,
    )
    .expect("save");

    let startup = Startup::open(Some(dir.path()));

    assert_eq!(startup.settings.settings, CHOSEN);
    assert!(startup.settings.fell_back.is_empty());
}

#[test]
fn without_app_data_the_start_uses_the_default_settings() {
    let dir = temp_dir();
    let path = app_data(dir.path(), &[]);
    Connection::open(&path)
        .expect("database")
        .pragma_update(None, "user_version", 9)
        .expect("version");

    assert_eq!(Startup::open(Some(dir.path())).settings, Loaded::default());
    assert_eq!(Startup::open(None).settings, Loaded::default());
}

#[test]
fn updating_saves_applies_and_forgets_old_fallbacks() {
    let dir = temp_dir();
    let workspace = workspace(dir.path());
    let preferences = Preferences::new(Loaded {
        settings: Settings::default(),
        fell_back: vec![SettingKey::Theme],
    });
    let mut applied = None;

    let view = preferences
        .update(CHOSEN, &workspace, |settings| applied = Some(*settings))
        .expect("update");

    assert_eq!(applied, Some(CHOSEN));
    assert_eq!(
        view,
        SettingsView {
            settings: CHOSEN,
            frame_at_start: FrameStyle::Liurium,
            fell_back: Vec::new(),
            zoom_steps: Zoom::STEPS.to_vec(),
        }
    );
    assert_eq!(preferences.settings(), CHOSEN);
    assert_eq!(stored_settings(dir.path()), CHOSEN);
}

#[test]
fn a_failed_save_applies_nothing() {
    let failed = DataStatus::Failed {
        error: CommandError::NewerVersion,
    };
    let workspace = Workspace::new(
        Some(PathBuf::from("unused")),
        &failed,
        Vec::new(),
        StartWith::default(),
    );
    let preferences = Preferences::new(Loaded::default());
    let mut applied = false;

    let result = preferences.update(CHOSEN, &workspace, |_| applied = true);

    assert_eq!(result, Err(CommandError::NewerVersion));
    assert!(!applied);
    assert_eq!(preferences.settings(), Settings::default());
}

#[test]
fn settings_from_the_page_must_be_allowed_values() {
    let valid = json!({
        "theme": "mint-graphite", "mode": "light", "frame": "hidden",
        "startup": "projectList", "zoom": 125
    });
    assert!(serde_json::from_value::<Settings>(valid.clone()).is_ok());
    let with = |key: &str, value: Value| {
        let mut changed = valid.clone();
        changed[key] = value;
        changed
    };
    let mut missing = valid.clone();
    missing.as_object_mut().expect("object").remove("zoom");
    for invalid in [
        with("theme", json!("violet")),
        with("mode", json!("auto")),
        with("frame", json!("frameless")),
        with("startup", json!("dashboard")),
        with("zoom", json!(130)),
        with("zoom", json!(-100)),
        with("zoom", json!("125")),
        with("path", json!("C:\\")),
        missing,
    ] {
        assert!(
            serde_json::from_value::<Settings>(invalid.clone()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn the_settings_view_uses_camel_case_names() {
    let view = Preferences::new(Loaded {
        settings: CHOSEN,
        fell_back: vec![SettingKey::Mode],
    })
    .view()
    .expect("view");

    assert_eq!(
        to_json(&view),
        json!({
            "settings": {
                "theme": "mint", "mode": "dark", "frame": "native",
                "startup": "projectList", "zoom": 100
            },
            "frameAtStart": "native",
            "fellBack": ["mode"],
            "zoomSteps": [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200],
        })
    );
}

#[test]
fn without_app_data_project_commands_report_why() {
    let failed = DataStatus::Failed {
        error: CommandError::NewerVersion,
    };
    let workspace = Workspace::new(
        Some(PathBuf::from("unused")),
        &failed,
        Vec::new(),
        StartWith::default(),
    );

    assert_eq!(workspace.current(), Err(CommandError::NewerVersion));
    assert_eq!(
        workspace.add(Path::new("unused")),
        Err(CommandError::NewerVersion)
    );
    let id = "00000000-0000-4000-8000-000000000001";
    assert_eq!(workspace.list(), Err(CommandError::NewerVersion));
    assert_eq!(workspace.open(id), Err(CommandError::NewerVersion));
    assert_eq!(workspace.rename(id, "x"), Err(CommandError::NewerVersion));
    assert_eq!(workspace.remove(id), Err(CommandError::NewerVersion));
    assert_eq!(
        workspace.locate(id, Path::new("unused")),
        Err(CommandError::NewerVersion)
    );
    assert_eq!(workspace.data_info(), Err(CommandError::NewerVersion));
    assert_eq!(workspace.prune_backups(), Err(CommandError::NewerVersion));
    assert_eq!(
        workspace.reset_sync_warnings(),
        Err(CommandError::NewerVersion)
    );
}

fn synced_workspace(app_dir: &Path, onedrive: &Path) -> Workspace {
    let startup = Startup::open(Some(app_dir));
    let roots = vec![SyncRoot {
        tool: SyncTool::OneDrive,
        folder: onedrive.to_owned(),
    }];
    Workspace::new(
        Some(app_dir.to_owned()),
        &startup.data,
        roots,
        startup.settings.settings.startup,
    )
}

fn synced_by(current: &CurrentProject) -> Option<SyncTool> {
    match current {
        CurrentProject::Open { project } => project.synced_by,
        _ => panic!("a project is open"),
    }
}

#[test]
fn a_project_in_a_sync_folder_is_warned_about_once() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let onedrive = dir.path().join("OneDrive");
    let fixture = project(&onedrive, "Garden", current(Kind::Project));
    let workspace = synced_workspace(&app_dir, &onedrive);

    let added = added(&workspace, &fixture.root);
    assert_eq!(added.synced_by, Some(SyncTool::OneDrive));
    assert_eq!(to_json(&added)["syncedBy"], json!("oneDrive"));
    // The page asks again while the project stays open: still shown in this session.
    let shown = workspace.current().expect("current");
    assert_eq!(synced_by(&shown), Some(SyncTool::OneDrive));

    let reopened = workspace.open(&fixture.id).expect("opened");
    assert_eq!(reopened.synced_by, None);
    let restarted = synced_workspace(&app_dir, &onedrive);
    assert_eq!(synced_by(&restarted.current().expect("current")), None);
}

#[test]
fn a_project_reopened_at_start_gets_its_first_warning_then() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let onedrive = dir.path().join("OneDrive");
    let fixture = project(&onedrive, "Garden", current(Kind::Project));
    // Added before Liurium knew the folder was synced.
    added(&workspace(&app_dir), &fixture.root);

    let restarted = synced_workspace(&app_dir, &onedrive);
    assert_eq!(
        synced_by(&restarted.current().expect("current")),
        Some(SyncTool::OneDrive)
    );
    restarted.rename(&fixture.id, "Kitchen").expect("renamed");
    let renamed = restarted.current().expect("current");
    assert_eq!(synced_by(&renamed), Some(SyncTool::OneDrive));

    let again = synced_workspace(&app_dir, &onedrive);
    assert_eq!(synced_by(&again.current().expect("current")), None);
}

#[test]
fn a_project_outside_sync_folders_is_not_warned_about() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let onedrive = dir.path().join("OneDrive");
    std::fs::create_dir(&onedrive).expect("sync folder");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    let workspace = synced_workspace(&app_dir, &onedrive);

    let added = added(&workspace, &fixture.root);

    assert_eq!(added.synced_by, None);
    assert_eq!(to_json(&added)["syncedBy"], json!(null));
}

/// A registered and open project "Original" and a folder "Copy" with a copy of its
/// `project.db`.
fn original_and_copy(dir: &Path, workspace: &Workspace) -> (ProjectInfo, PathBuf) {
    let fixture = project(dir, "Original", current(Kind::Project));
    let original = added(workspace, &fixture.root);
    let copy = dir.join("Copy");
    std::fs::create_dir_all(copy.join(".liurium")).expect("folders");
    std::fs::copy(fixture.database(), copy.join(".liurium").join("project.db")).expect("copy");
    (original, copy)
}

#[test]
fn adding_a_copy_asks_and_keeps_the_open_project_open() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));
    let (original, copy) = original_and_copy(dir.path(), &workspace);
    let before = TreeSnapshot::of(&copy);

    let outcome = workspace.add(&copy).expect("asked");

    let long = std::fs::canonicalize(&copy).expect("folder");
    assert_eq!(
        to_json(&outcome),
        json!({
            "state": "copy",
            "folder": long.to_string_lossy().trim_start_matches(r"\\?\"),
            "originalName": "Original",
            "originalFolder": original.folder,
        })
    );
    before.assert_unchanged(&copy);
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open { project: original }
    );
    assert_eq!(workspace.list().expect("list").len(), 1);
}

#[test]
fn separating_the_copy_opens_it_as_its_own_project() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));
    let (original, copy) = original_and_copy(dir.path(), &workspace);
    workspace.add(&copy).expect("asked");

    let separated = workspace.separate_copy().expect("separated");

    assert_ne!(separated.id, original.id);
    assert_eq!(separated.name, "Copy");
    assert_eq!(
        workspace.current().expect("current"),
        CurrentProject::Open {
            project: separated.clone()
        }
    );
    assert_eq!(
        statuses(&workspace),
        [
            ("Copy".to_owned(), ProjectStatus::Open),
            ("Original".to_owned(), ProjectStatus::Available),
        ]
    );
    assert_eq!(
        workspace.open(&original.id).expect("opened").name,
        "Original"
    );
    assert_eq!(workspace.open(&separated.id).expect("opened").name, "Copy");
}

#[test]
fn the_question_about_a_copy_is_answered_once() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));
    let (_original, copy) = original_and_copy(dir.path(), &workspace);
    workspace.add(&copy).expect("asked");
    workspace.separate_copy().expect("separated");
    let before = TreeSnapshot::of(&copy);

    assert_eq!(workspace.separate_copy(), Err(CommandError::NotFound));
    before.assert_unchanged(&copy);
}

#[test]
fn a_new_add_drops_the_unanswered_question() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));
    let (_original, copy) = original_and_copy(dir.path(), &workspace);
    workspace.add(&copy).expect("asked");
    let other = project(dir.path(), "Other", current(Kind::Project));
    added(&workspace, &other.root);
    let before = TreeSnapshot::of(&copy);

    assert_eq!(workspace.separate_copy(), Err(CommandError::NotFound));
    before.assert_unchanged(&copy);
    assert_eq!(workspace.list().expect("list").len(), 2);
}

#[test]
fn without_a_question_nothing_is_separated() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));

    assert_eq!(workspace.separate_copy(), Err(CommandError::NotFound));
}

fn save_startup(app_dir: &Path, startup: StartWith) {
    let mut conn =
        db::open(&app_dir.join("app.db"), Kind::App, db::OpenMode::Existing).expect("app.db");
    let settings = Settings {
        startup,
        ..stored::load(&conn).expect("settings").settings
    };
    stored::save(&mut conn, &settings).expect("save");
}

#[test]
fn with_the_project_list_at_start_no_project_reopens() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let fixture = project(dir.path(), "Garden", current(Kind::Project));
    added(&workspace(&app_dir), &fixture.root);
    save_startup(&app_dir, StartWith::ProjectList);
    let before = TreeSnapshot::of(&fixture.root);

    let restarted = workspace(&app_dir);

    assert_eq!(restarted.current(), Ok(CurrentProject::None));
    assert_eq!(
        statuses(&restarted),
        [("Garden".to_owned(), ProjectStatus::Available)]
    );
    before.assert_unchanged(&fixture.root);
    // Opening it by hand still works, and the next start with the default reopens it.
    restarted.open(&fixture.id).expect("opened");
    save_startup(&app_dir, StartWith::LastProject);
    assert!(matches!(
        workspace(&app_dir).current(),
        Ok(CurrentProject::Open { .. })
    ));
}

fn backup(app_dir: &Path, name: &str) {
    let dir = app_dir.join(db::BACKUP_DIR);
    std::fs::create_dir_all(&dir).expect("backups");
    std::fs::write(dir.join(name), b"copy").expect("backup");
}

#[test]
fn app_data_info_names_the_folder_backups_and_sync_warnings() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let onedrive = dir.path().join("OneDrive");
    let fixture = project(&onedrive, "Garden", current(Kind::Project));
    let workspace = synced_workspace(&app_dir, &onedrive);
    added(&workspace, &fixture.root);
    for day in 1..=5 {
        backup(&app_dir, &format!("app-v1-2026110{day}T080000Z.db"));
    }
    backup(&app_dir, "notes.txt");

    let info = workspace.data_info().expect("info");

    assert_eq!(
        to_json(&info),
        json!({
            "folder": app_dir.to_string_lossy(),
            "backups": 5,
            "backupBytes": 20,
            "keptBackups": 3,
            "syncWarned": 1,
        })
    );
}

#[test]
fn pruning_keeps_the_newest_three_backups_and_reports_the_rest() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let workspace = workspace(&app_dir);
    workspace.current().expect("app.db exists");
    for day in 1..=5 {
        backup(&app_dir, &format!("app-v1-2026110{day}T080000Z.db"));
    }
    let app_db = Snapshot::of(&app_dir.join("app.db"));

    let info = workspace.prune_backups().expect("pruned");

    assert_eq!(info.backups, 3);
    let mut left: Vec<String> = std::fs::read_dir(app_dir.join(db::BACKUP_DIR))
        .expect("backups")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            "app-v1-20261103T080000Z.db",
            "app-v1-20261104T080000Z.db",
            "app-v1-20261105T080000Z.db",
        ]
    );
    app_db.assert_unchanged(&app_dir.join("app.db"));
    assert_eq!(workspace.prune_backups().expect("again").backups, 3);
}

#[test]
fn resetting_sync_warnings_warns_again_at_the_next_open() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let onedrive = dir.path().join("OneDrive");
    let fixture = project(&onedrive, "Garden", current(Kind::Project));
    let workspace = synced_workspace(&app_dir, &onedrive);
    added(&workspace, &fixture.root);

    let info = workspace.reset_sync_warnings().expect("reset");

    assert_eq!(info.sync_warned, 0);
    let reopened = synced_workspace(&app_dir, &onedrive);
    assert_eq!(
        synced_by(&reopened.current().expect("current")),
        Some(SyncTool::OneDrive)
    );
}

#[test]
fn explorer_is_started_by_its_full_path_with_the_folder_quoted() {
    let folder = Path::new(r"C:\Users\A, B\AppData\Local\io.github.greatmightycrow.liurium");
    let command = super::data::explorer(folder).expect("command");

    let program = PathBuf::from(command.get_program());
    assert!(program.is_absolute(), "{}", program.display());
    assert!(program.ends_with("explorer.exe"));
    assert_eq!(
        super::data::quoted(folder),
        Some(format!("\"{}\"", folder.display()))
    );
    assert_eq!(super::data::quoted(Path::new("C:\\a\"b")), None);
}

fn note_paths(view: &notes::NotesView) -> Vec<String> {
    match view {
        notes::NotesView::Ready { notes, .. } => {
            notes.iter().map(|note| note.path.clone()).collect()
        }
        notes::NotesView::NoProject => panic!("no project"),
    }
}

fn write_note(root: &Path, rel: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    std::fs::write(path, rel).expect("note");
}

#[test]
fn without_an_open_project_the_notes_say_so() {
    let dir = temp_dir();

    let view = workspace(&dir.path().join("app")).notes().expect("notes");

    assert_eq!(to_json(&view), json!({ "state": "noProject" }));
}

#[test]
fn the_open_projects_notes_are_listed_with_size_time_and_skips() {
    let dir = temp_dir();
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    write_note(&garden.root, "Ideas/Plan.md");
    write_note(&garden.root, "README.md");
    write_note(&garden.root, "node_modules/pkg/README.md");
    let workspace = workspace(&dir.path().join("app"));
    added(&workspace, &garden.root);

    let view = workspace.notes().expect("notes");

    let modified = std::fs::metadata(garden.root.join("README.md"))
        .and_then(|metadata| metadata.modified())
        .expect("time")
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after 1970")
        .as_millis();
    let json = to_json(&view);
    assert_eq!(json["state"], "ready");
    assert_eq!(
        json["notes"][1],
        json!({ "path": "README.md", "size": 9, "modifiedMs": modified as u64 })
    );
    assert_eq!(note_paths(&view), ["Ideas/Plan.md", "README.md"]);
    assert_eq!(
        json["skipped"],
        json!({
            "linksOutside": 0,
            "brokenLinks": 0,
            "badNames": 0,
            "unreadable": 0,
            "tooDeep": 0,
            "depthLimit": 64,
        })
    );
    assert_eq!(json["truncated"], false);
    assert_eq!(json["noteLimit"], 100_000);
}

#[test]
fn the_notes_follow_the_open_project() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    write_note(&garden.root, "garden.md");
    write_note(&work.root, "work.md");
    let workspace = workspace(&app_dir);
    added(&workspace, &garden.root);
    added(&workspace, &work.root);
    assert_eq!(note_paths(&workspace.notes().expect("notes")), ["work.md"]);

    workspace.open(&garden.id).expect("opened");
    assert_eq!(
        note_paths(&workspace.notes().expect("notes")),
        ["garden.md"]
    );

    workspace.remove(&garden.id).expect("removed");
    assert_eq!(
        workspace.notes().expect("notes"),
        notes::NotesView::NoProject
    );
}

#[test]
fn after_a_restart_the_reopened_projects_notes_are_listed_from_its_cache() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    write_note(&garden.root, "a.md");
    let first = workspace(&app_dir);
    added(&first, &garden.root);
    first.notes().expect("notes");
    drop(first);
    write_note(&garden.root, "b.md");

    let view = workspace(&app_dir).notes().expect("notes");

    assert_eq!(note_paths(&view), ["a.md", "b.md"]);
    assert!(
        app_dir
            .join("cache")
            .join(format!("{}.db", garden.id))
            .is_file()
    );
}

#[test]
fn only_the_newest_walk_counts() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    std::fs::create_dir(&app_dir).expect("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    write_note(&work.root, "work.md");
    let root = |folder: &Path| crate::storage::fs::ProjectRoot::open(folder).expect("root");
    let index = notes::NoteIndex::default();

    index.start(app_dir.clone(), garden.id.clone(), root(&garden.root));
    index.start(app_dir.clone(), work.id.clone(), root(&work.root));

    assert_eq!(index.wait(&garden.id), None);
    let view = index.wait(&work.id).expect("work's walk").expect("view");
    assert_eq!(note_paths(&view), ["work.md"]);
    index.clear();
    assert_eq!(index.wait(&work.id), None);
}

fn opened_garden(dir: &Path) -> (Workspace, PathBuf) {
    let garden = project(dir, "Garden", current(Kind::Project));
    let workspace = workspace(&dir.join("app"));
    added(&workspace, &garden.root);
    (workspace, garden.root)
}

#[test]
fn a_note_opens_saves_and_reports_its_state_as_json() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::create_dir(root.join("Ideas")).expect("folder");
    std::fs::write(root.join("Ideas/Plan.md"), "a\r\nb").expect("note");

    let opened = workspace.open_note("Ideas/Plan.md", false).expect("open");
    assert_eq!(
        to_json(&opened),
        json!({
            "path": "Ideas/Plan.md",
            "text": "a\r\nb",
            "lineEnding": "crlf",
            "readOnly": null,
            "unsaved": false,
            "conflict": false,
        })
    );

    let draft = workspace
        .update_note("Ideas/Plan.md", "a\r\nb\r\nc", false)
        .expect("draft");
    assert_eq!(to_json(&draft), json!("draft"));
    let reopened = workspace
        .open_note("ideas/plan.md", false)
        .expect("same note");
    assert_eq!(reopened.text, "a\r\nb\r\nc");
    assert!(reopened.unsaved);

    let saved = workspace
        .update_note("Ideas/Plan.md", "a\r\nb\r\nc", true)
        .expect("save");
    assert_eq!(to_json(&saved), json!("saved"));
    assert_eq!(
        std::fs::read(root.join("Ideas/Plan.md")).expect("note"),
        b"a\r\nb\r\nc"
    );
    workspace.close_note("Ideas/Plan.md").expect("closed");
}

#[test]
fn only_note_paths_inside_the_open_project_can_be_opened() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("secret.txt"), "x").expect("file");
    std::fs::create_dir_all(root.join("node_modules")).expect("folder");
    std::fs::write(root.join("node_modules/x.md"), "x").expect("file");
    std::fs::write(dir.path().join("outside.md"), "x").expect("file");

    for path in [
        ".liurium/project.db",
        "secret.txt",
        "node_modules/x.md",
        "../outside.md",
        r"C:\Windows\win.ini",
    ] {
        let error = workspace.open_note(path, false).unwrap_err();
        assert_eq!(error, CommandError::InvalidPath, "{path}");
    }
    assert_eq!(
        workspace.open_note("missing.md", false).unwrap_err(),
        CommandError::NotFound
    );
    assert_eq!(
        workspace.update_note("other.md", "x", true).unwrap_err(),
        CommandError::NotFound
    );
}

#[test]
fn without_a_project_no_note_opens() {
    let dir = temp_dir();
    let workspace = workspace(&dir.path().join("app"));

    assert_eq!(
        workspace.open_note("a.md", false).unwrap_err(),
        CommandError::NoProject
    );
}

#[test]
fn a_conflict_waits_for_the_choice_and_keep_both_moves_to_the_copy() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("Plan.md"), "mine").expect("note");
    workspace.open_note("Plan.md", false).expect("open");
    std::fs::write(root.join("Plan.md"), "theirs, longer").expect("outside");

    let state = workspace
        .update_note("Plan.md", "mine, edited", true)
        .expect("save");
    assert_eq!(state, editor::SaveState::Conflict);
    assert_eq!(
        workspace.close_note("Plan.md").unwrap_err(),
        CommandError::Unsaved
    );

    let opened = workspace
        .resolve_note_conflict("Plan.md", editor::ConflictChoice::KeepBoth)
        .expect("keep both");
    assert_eq!(opened.path, "Plan (conflict).md");
    assert!(!opened.conflict);
    assert_eq!(
        std::fs::read_to_string(root.join("Plan.md")).expect("note"),
        "theirs, longer"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Plan (conflict).md")).expect("copy"),
        "mine, edited"
    );
}

#[test]
fn opening_another_note_or_project_saves_the_draft_first() {
    let dir = temp_dir();
    let app_dir = dir.path().join("app");
    let garden = project(dir.path(), "Garden", current(Kind::Project));
    let work = project(dir.path(), "Work", current(Kind::Project));
    std::fs::write(garden.root.join("a.md"), "a").expect("note");
    std::fs::write(garden.root.join("b.md"), "b").expect("note");
    let workspace = workspace(&app_dir);
    added(&workspace, &work.root);
    added(&workspace, &garden.root);

    workspace.open_note("a.md", false).expect("open");
    workspace
        .update_note("a.md", "a, draft", false)
        .expect("draft");
    workspace.open_note("b.md", false).expect("other note");
    assert_eq!(
        std::fs::read_to_string(garden.root.join("a.md")).expect("a"),
        "a, draft"
    );

    workspace
        .update_note("b.md", "b, draft", false)
        .expect("draft");
    workspace.open(&work.id).expect("other project");
    assert_eq!(
        std::fs::read_to_string(garden.root.join("b.md")).expect("b"),
        "b, draft"
    );
}

#[test]
fn closing_the_window_saves_the_draft_or_reports_what_is_unsaved() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("Plan.md"), "mine").expect("note");
    workspace.open_note("Plan.md", false).expect("open");
    let editor = workspace.editor();
    assert_eq!(editor.save_before_close(), editor::CloseCheck::Clear);

    workspace
        .update_note("Plan.md", "draft", false)
        .expect("draft");
    assert_eq!(editor.save_before_close(), editor::CloseCheck::Clear);
    assert_eq!(
        std::fs::read_to_string(root.join("Plan.md")).expect("note"),
        "draft"
    );

    workspace
        .update_note("Plan.md", "second", false)
        .expect("draft");
    std::fs::write(root.join("Plan.md"), "changed outside").expect("outside");
    assert_eq!(
        editor.save_before_close(),
        editor::CloseCheck::Unsaved {
            name: "Plan.md".to_owned(),
            conflict: true
        }
    );
    assert!(editor.keep_both_before_close());
    assert_eq!(
        std::fs::read_to_string(root.join("Plan (conflict).md")).expect("copy"),
        "second"
    );
    assert_eq!(editor.save_before_close(), editor::CloseCheck::Clear);
}

#[test]
fn note_errors_cross_ipc_as_their_own_kinds() {
    assert_eq!(
        to_json(&CommandError::NotUtf8),
        json!({ "kind": "notUtf8" })
    );
    assert_eq!(
        to_json(&CommandError::Unsaved),
        json!({ "kind": "unsaved" })
    );
}

fn tree_paths(workspace: &Workspace) -> (Vec<String>, Vec<String>) {
    match workspace.notes().expect("notes") {
        notes::NotesView::Ready {
            notes,
            empty_folders,
            ..
        } => (
            notes.into_iter().map(|note| note.path).collect(),
            empty_folders,
        ),
        notes::NotesView::NoProject => panic!("no project"),
    }
}

#[test]
fn notes_and_folders_are_created_renamed_moved_and_listed_again() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());

    assert_eq!(
        workspace.create_folder("", "Ideas").expect("folder"),
        "Ideas"
    );
    assert_eq!(tree_paths(&workspace).1, ["Ideas"]);
    assert_eq!(
        workspace.create_note("Ideas", "Plan").expect("note"),
        "Ideas/Plan.md"
    );
    assert_eq!(
        std::fs::read(root.join("Ideas/Plan.md")).expect("note"),
        b""
    );
    assert_eq!(
        workspace
            .rename_entry("Ideas/Plan.md", "Roadmap")
            .expect("rename"),
        "Ideas/Roadmap.md"
    );
    workspace.create_folder("", "Archive").expect("folder");
    assert_eq!(
        workspace
            .move_entry("Ideas/Roadmap.md", "Archive")
            .expect("move"),
        "Archive/Roadmap.md"
    );
    assert_eq!(
        workspace
            .rename_entry("Archive", "Old")
            .expect("rename folder"),
        "Old"
    );

    let (notes, empty) = tree_paths(&workspace);
    assert_eq!(notes, ["Old/Roadmap.md"]);
    assert_eq!(empty, ["Ideas"]);
}

#[test]
fn nothing_is_created_or_renamed_over_an_existing_item() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("Plan.md"), "plan").expect("note");
    std::fs::write(root.join("Other.md"), "other").expect("note");

    assert_eq!(
        workspace.create_note("", "Plan").unwrap_err(),
        CommandError::AlreadyExists
    );
    assert_eq!(
        workspace.rename_entry("Plan.md", "Other").unwrap_err(),
        CommandError::AlreadyExists
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Plan.md")).expect("note"),
        "plan"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Other.md")).expect("note"),
        "other"
    );
}

#[test]
fn names_and_paths_from_the_page_follow_the_tree_rules() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("Plan.md"), "plan").expect("note");
    std::fs::write(root.join("code.rs"), "fn main() {}").expect("file");

    for (result, expected) in [
        (
            workspace.create_folder("", "node_modules"),
            CommandError::SkippedName,
        ),
        (
            workspace.create_folder("", ".hidden"),
            CommandError::SkippedName,
        ),
        (
            workspace.create_note(".liurium", "x"),
            CommandError::SkippedName,
        ),
        (
            workspace.create_note("../outside", "x"),
            CommandError::InvalidPath,
        ),
        (
            workspace.rename_entry("Plan.md", "a/b"),
            CommandError::InvalidPath,
        ),
        (
            workspace.rename_entry("code.rs", "code2"),
            CommandError::InvalidPath,
        ),
        (
            workspace.move_entry("Plan.md", "missing"),
            CommandError::NotFound,
        ),
    ] {
        assert_eq!(result.unwrap_err(), expected);
    }
    assert!(workspace.trash_entry("code.rs").is_err());
    assert!(root.join("code.rs").exists());
}

#[test]
fn trashing_moves_into_the_projects_trash_and_closes_the_open_note() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::create_dir(root.join("Ideas")).expect("folder");
    std::fs::write(root.join("Ideas/Plan.md"), "plan").expect("note");
    workspace.open_note("Ideas/Plan.md", false).expect("open");
    workspace
        .update_note("Ideas/Plan.md", "plan, draft", false)
        .expect("draft");

    workspace.trash_entry("Ideas").expect("trash");

    assert!(!root.join("Ideas").exists());
    let trash = root.join(".liurium").join("trash");
    let batch = std::fs::read_dir(&trash)
        .expect("trash")
        .next()
        .expect("one batch")
        .expect("entry")
        .path();
    assert_eq!(
        std::fs::read_to_string(batch.join("Ideas").join("Plan.md")).expect("trashed"),
        "plan, draft",
        "the draft was saved before the move"
    );
    assert_eq!(
        workspace
            .update_note("Ideas/Plan.md", "x", true)
            .unwrap_err(),
        CommandError::NotFound
    );
    assert_eq!(tree_paths(&workspace).0, Vec::<String>::new());
}

#[test]
fn the_open_note_follows_a_rename_of_its_folder_and_keeps_its_draft() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::create_dir(root.join("Ideas")).expect("folder");
    std::fs::write(root.join("Ideas/Plan.md"), "plan").expect("note");
    workspace.open_note("Ideas/Plan.md", false).expect("open");
    workspace
        .update_note("Ideas/Plan.md", "plan, draft", false)
        .expect("draft");

    workspace.rename_entry("Ideas", "Thoughts").expect("rename");

    assert_eq!(
        std::fs::read_to_string(root.join("Thoughts/Plan.md")).expect("moved"),
        "plan, draft"
    );
    let opened = workspace
        .open_note("Thoughts/Plan.md", false)
        .expect("same note");
    assert_eq!(opened.text, "plan, draft");
    workspace
        .update_note("Thoughts/Plan.md", "plan, edited", true)
        .expect("save at the new place");
    assert_eq!(
        std::fs::read_to_string(root.join("Thoughts/Plan.md")).expect("note"),
        "plan, edited"
    );
}

#[test]
fn an_unsolved_conflict_blocks_moving_the_open_note() {
    let dir = temp_dir();
    let (workspace, root) = opened_garden(dir.path());
    std::fs::write(root.join("Plan.md"), "mine").expect("note");
    workspace.open_note("Plan.md", false).expect("open");
    std::fs::write(root.join("Plan.md"), "theirs, longer").expect("outside");
    workspace
        .update_note("Plan.md", "mine, edited", true)
        .expect("conflict");

    assert_eq!(
        workspace.rename_entry("Plan.md", "Renamed").unwrap_err(),
        CommandError::Unsaved
    );
    assert_eq!(
        workspace.trash_entry("Plan.md").unwrap_err(),
        CommandError::Unsaved
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Plan.md")).expect("note"),
        "theirs, longer"
    );
}
