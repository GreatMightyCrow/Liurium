//! App settings (M2-007): theme, mode, and window frame, kept in the `settings` table
//! of `app.db` with JSON values. A missing value means the default. A value Liurium
//! cannot read also gives the default and is reported, so a broken entry never stops
//! the start; the next save replaces it.

use std::io;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

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
}

/// One stored value, named as in the `settings` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "SettingKey.ts"))]
pub enum SettingKey {
    Theme,
    Mode,
    Frame,
}

impl SettingKey {
    fn name(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::Mode => "mode",
            Self::Frame => "frame",
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
