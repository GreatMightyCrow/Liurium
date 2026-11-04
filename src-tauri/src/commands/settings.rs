//! Settings commands (M2-007, M3-009). The page sends whole `Settings`; serde rejects
//! any value outside the allowed themes, modes, frame styles, startup choices, and
//! zoom steps before Rust sees it.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use super::{CommandError, Workspace};
use crate::domain::settings::{self, Loaded, SettingKey, Settings, Zoom};
use crate::frame::FrameStyle;
use crate::window;

/// What the Settings page shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SettingsView.ts"))]
pub struct SettingsView {
    pub settings: Settings,
    /// The window was created with this style; another stored one needs a restart.
    pub frame_at_start: FrameStyle,
    /// Stored values that could not be read at start; the defaults replace them.
    pub fell_back: Vec<SettingKey>,
    /// The zoom steps Rust accepts, smallest first, so the page never guesses them.
    pub zoom_steps: Vec<u16>,
}

/// The settings in use: read at start, before the window exists, and changed by
/// `update_settings`.
pub struct Preferences {
    current: Mutex<Loaded>,
    frame_at_start: FrameStyle,
}

impl Preferences {
    pub fn new(loaded: Loaded) -> Self {
        Self {
            frame_at_start: loaded.settings.frame,
            current: Mutex::new(loaded),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Loaded>, CommandError> {
        self.current.lock().map_err(|_| CommandError::Internal)
    }

    /// For the window, which follows Windows' mode changes with the current theme.
    pub fn settings(&self) -> Settings {
        self.lock()
            .map(|current| current.settings)
            .unwrap_or_default()
    }

    pub fn view(&self) -> Result<SettingsView, CommandError> {
        let current = self.lock()?;
        Ok(SettingsView {
            settings: current.settings,
            frame_at_start: self.frame_at_start,
            fell_back: current.fell_back.clone(),
            zoom_steps: Zoom::STEPS.to_vec(),
        })
    }

    /// Saves first; only saved settings are applied. `apply` runs after the lock is
    /// released, because changing the window's theme may report back to `settings`.
    pub fn update(
        &self,
        settings: Settings,
        workspace: &Workspace,
        apply: impl FnOnce(&Settings),
    ) -> Result<SettingsView, CommandError> {
        {
            let mut current = self.lock()?;
            settings::save(&mut workspace.app()?, &settings)?;
            *current = Loaded {
                settings,
                fell_back: Vec::new(),
            };
        }
        apply(&settings);
        self.view()
    }
}

#[tauri::command]
pub fn get_settings(preferences: State<'_, Preferences>) -> Result<SettingsView, CommandError> {
    preferences.view()
}

#[tauri::command]
pub fn update_settings(
    settings: Settings,
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
    preferences: State<'_, Preferences>,
) -> Result<SettingsView, CommandError> {
    preferences.update(settings, &workspace, |settings| {
        window::apply(&window, settings);
    })
}

/// Lets Tauri close the app as usual, then starts the same exe with the same
/// arguments, so a new frame style applies.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.request_restart();
}
