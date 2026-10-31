//! Test switches of the end-to-end build (Cargo feature `e2e`, ADR-0019). This module
//! is not compiled into the normal build; CI checks that its variable names are absent
//! from the normal binary.

use std::{env, path::PathBuf};

/// App data folder for the test run, so tests never touch the user's own data.
const DATA_DIR: &str = "LIURIUM_E2E_DATA_DIR";
/// Folder that "Add project folder" uses instead of showing the dialog.
const PICK: &str = "LIURIUM_E2E_PICK";

pub fn data_dir() -> Option<PathBuf> {
    env::var_os(DATA_DIR).map(PathBuf::from)
}

pub fn picked_folder() -> Option<PathBuf> {
    env::var_os(PICK).map(PathBuf::from)
}
