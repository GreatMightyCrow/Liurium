//! Test switches of the end-to-end build (Cargo feature `e2e`, ADR-0019). This module
//! is not compiled into the normal build; CI checks that its variable names are absent
//! from the normal binary.

use std::{env, path::PathBuf};

use crate::domain::sync::{SyncRoot, SyncTool};

/// App data folder for the test run, so tests never touch the user's own data.
const DATA_DIR: &str = "LIURIUM_E2E_DATA_DIR";
/// Folder that "Add project folder" uses instead of showing the dialog.
const PICK: &str = "LIURIUM_E2E_PICK";
/// Folder treated as OneDrive's; the test build ignores the real sync folders.
const ONEDRIVE: &str = "LIURIUM_E2E_ONEDRIVE";
/// Leaves only the check at window focus, as on a drive without change reports.
const NO_WATCH: &str = "LIURIUM_E2E_NO_WATCH";

/// File that records opened addresses, so tests and CI start no browser (M3-012).
const OPENED_LINKS: &str = "LIURIUM_E2E_OPENED_LINKS";

pub fn opened_links() -> Option<PathBuf> {
    env::var_os(OPENED_LINKS).map(PathBuf::from)
}

pub fn no_watch() -> bool {
    env::var_os(NO_WATCH).is_some()
}

pub fn data_dir() -> Option<PathBuf> {
    env::var_os(DATA_DIR).map(PathBuf::from)
}

pub fn picked_folder() -> Option<PathBuf> {
    env::var_os(PICK).map(PathBuf::from)
}

pub fn sync_roots() -> Vec<SyncRoot> {
    env::var_os(ONEDRIVE)
        .map(|folder| SyncRoot {
            tool: SyncTool::OneDrive,
            folder: PathBuf::from(folder),
        })
        .into_iter()
        .collect()
}
