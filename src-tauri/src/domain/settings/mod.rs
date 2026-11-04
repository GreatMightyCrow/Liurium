//! App settings (M2-007, M3-009): theme, mode, window frame, what opens at start, and
//! zoom, kept in the `settings` table of `app.db` with JSON values. A missing value
//! means the default. A value Liurium cannot read also gives the default and is
//! reported, so a broken entry never stops the start; the next save replaces it.

use std::io;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, DeserializeOwned},
};

use crate::frame::FrameStyle;
use crate::storage::db::DbError;
use crate::theme::{Mode, ThemeChoice};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "Settings.ts"))]
pub struct Settings {
    pub theme: ThemeChoice,
    pub mode: Mode,
    pub frame: FrameStyle,
    pub startup: StartWith,
    pub zoom: Zoom,
}

/// What Liurium shows when it starts (M3-009).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "StartWith.ts"))]
pub enum StartWith {
    /// Reopens the project that was open when Liurium last closed.
    #[default]
    LastProject,
    /// Opens no project and shows the project list.
    ProjectList,
}

/// The zoom of the page in percent (M3-009). Only Chromium's own zoom steps from 50 to
/// 200 % are accepted, so a value from the page or the database can never make the
/// page unusably small or large.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "Zoom.ts"))]
pub struct Zoom(u16);

/// A plain number in JSON; reading checks the step.
impl Serialize for Zoom {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u16(self.0)
    }
}

impl<'de> Deserialize<'de> for Zoom {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let percent = u16::deserialize(deserializer)?;
        Self::try_from(percent).map_err(de::Error::custom)
    }
}

impl Zoom {
    pub const STEPS: [u16; 11] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
    pub const DEFAULT: Self = Self(100);

    pub fn percent(self) -> u16 {
        self.0
    }

    /// For `Webview::set_zoom`, where 1.0 is 100 %.
    pub fn factor(self) -> f64 {
        f64::from(self.0) / 100.0
    }
}

impl Default for Zoom {
    fn default() -> Self {
        Self::DEFAULT
    }
}

impl TryFrom<u16> for Zoom {
    type Error = String;

    fn try_from(percent: u16) -> Result<Self, Self::Error> {
        if Self::STEPS.contains(&percent) {
            Ok(Self(percent))
        } else {
            Err(format!("{percent} % is not a zoom step"))
        }
    }
}

/// One stored value, named as in the `settings` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SettingKey.ts"))]
pub enum SettingKey {
    Theme,
    Mode,
    Frame,
    Startup,
    Zoom,
}

impl SettingKey {
    fn name(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::Mode => "mode",
            Self::Frame => "frame",
            Self::Startup => "startup",
            Self::Zoom => "zoom",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Loaded {
    pub settings: Settings,
    /// Values that were stored but could not be read; the defaults replace them.
    pub fell_back: Vec<SettingKey>,
}

pub fn load(conn: &Connection) -> Result<Loaded, DbError> {
    let mut fell_back = Vec::new();
    let settings = Settings {
        theme: read(conn, SettingKey::Theme, &mut fell_back)?,
        mode: read(conn, SettingKey::Mode, &mut fell_back)?,
        frame: read(conn, SettingKey::Frame, &mut fell_back)?,
        startup: read(conn, SettingKey::Startup, &mut fell_back)?,
        zoom: read(conn, SettingKey::Zoom, &mut fell_back)?,
    };
    Ok(Loaded {
        settings,
        fell_back,
    })
}

fn read<T: DeserializeOwned + Default>(
    conn: &Connection,
    key: SettingKey,
    fell_back: &mut Vec<SettingKey>,
) -> Result<T, DbError> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key.name()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match stored {
        None => T::default(),
        Some(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
            fell_back.push(key);
            T::default()
        }),
    })
}

/// Writes all values in one transaction, so a failed save leaves the old ones.
pub fn save(conn: &mut Connection, settings: &Settings) -> Result<(), DbError> {
    let values = [
        (SettingKey::Theme, json(&settings.theme)?),
        (SettingKey::Mode, json(&settings.mode)?),
        (SettingKey::Frame, json(&settings.frame)?),
        (SettingKey::Startup, json(&settings.startup)?),
        (SettingKey::Zoom, json(&settings.zoom)?),
    ];
    let transaction = conn.transaction()?;
    for (key, value) in values {
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key.name(), value],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn json<T: Serialize>(value: &T) -> Result<String, DbError> {
    Ok(serde_json::to_string(value).map_err(io::Error::other)?)
}

#[cfg(test)]
mod tests;
