//! Adding, opening, and managing projects (ADR-0016, M2-005, M2-006). A project is a folder with
//! `.liurium/project.db`, which holds its identity; the registry in `app.db` remembers
//! where each project was last seen. Liurium writes only `.liurium` into the folder.

mod error;
#[cfg(test)]
mod tests;

use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, MAIN_DB, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use error::ProjectError;

use crate::storage::{
    db::{self, DbError, Kind, OpenMode, PROJECT_DB},
    fs::{self as storage_fs, LIURIUM_DIR, ProjectRoot},
};

/// Keeps Git from committing backups and SQLite's side files; `project.db` itself
/// stays visible so Git users can commit their tasks (ADR-0016).
const GITIGNORE: &str = "# Written by Liurium. project.db holds this project's identity and tasks.\n\
backups/\n\
*-journal\n\
*-wal\n\
*-shm\n";

/// Display names come from `project.db`, which is untrusted input.
const MAX_NAME_CHARS: usize = 200;

/// An open project. Dropping it closes `project.db`.
#[derive(Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: ProjectRoot,
    /// `project.db` or the folder is write-protected: nothing is written.
    pub read_only: bool,
    connection: Connection,
}

impl Project {
    pub fn connection(&self) -> &Connection {
        &self.connection
    }
}

/// Adds the folder as a project and opens it. A folder with `.liurium/project.db` is
/// an existing project and keeps its identity; otherwise `.liurium` is created.
pub fn add(app: &Connection, folder: &Path) -> Result<Project, ProjectError> {
    let root = ProjectRoot::open(folder)?;
    if !root.suitable() {
        return Err(ProjectError::Unsuitable);
    }
    let project = match root.liurium_dir()? {
        Some(dir) if dir.join(PROJECT_DB).try_exists()? => load(root)?,
        existing => create(root, existing)?,
    };
    register(app, &project)?;
    opened(app, &project)?;
    Ok(project)
}

/// Opens a registered project by its id.
pub fn open(app: &Connection, id: &str) -> Result<Project, ProjectError> {
    let project = find(app, id)?;
    opened(app, &project)?;
    Ok(project)
}

/// Loads a registered project without counting it as opened (M2-006 rename).
pub fn find(app: &Connection, id: &str) -> Result<Project, ProjectError> {
    let path = registered_path(app, id)?;
    let project = load(ProjectRoot::open(Path::new(&path))?)?;
    if project.id != id {
        return Err(ProjectError::OtherProject);
    }
    Ok(project)
}

/// A folder that holds the same project as a registered folder that still holds it:
/// one of them was copied (ADR-0016). Found when a folder is added; nothing is written
/// until the user decides (M2-011).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectCopy {
    /// The folder that was added.
    pub folder: PathBuf,
    /// The same folder, as Windows shows it.
    pub display: String,
    /// The id the copy shares with the original.
    pub id: String,
    /// The original's name and folder, as the registry has them.
    pub original_name: String,
    pub original_folder: String,
}

/// Gives a copied project folder its own identity, once the user has agreed (M2-011):
/// a new id and the folder's name, in one transaction in the copy's `project.db`. The
/// copy must still hold the id it was asked about. The original is not touched.
pub fn separate(app: &Connection, copy: &ProjectCopy) -> Result<Project, ProjectError> {
    let root = ProjectRoot::open(&copy.folder)?;
    if !root.suitable() {
        return Err(ProjectError::Unsuitable);
    }
    let mut project = load(root)?;
    if project.id != copy.id {
        return Err(ProjectError::Changed);
    }
    if project.read_only {
        return Err(DbError::ReadOnly.into());
    }
    let id = new_id(&project.connection)?;
    let name = default_name(&project.root);
    let transaction = project.connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'id' AND value = ?2",
        params![id, copy.id],
    )?;
    if changed != 1 {
        // Dropping the transaction rolls it back.
        return Err(ProjectError::Changed);
    }
    transaction.execute(
        "INSERT INTO meta (key, value) VALUES ('name', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [&name],
    )?;
    transaction.commit()?;
    project.id = id;
    project.name = name;
    // If the registry write fails now, the copy is a new project that is not listed
    // yet; adding it again lists it.
    register(app, &project)?;
    opened(app, &project)?;
    Ok(project)
}

/// A registry entry as the project list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    /// Cached from `project.db`, so it can be shown while the folder is missing.
    pub name: String,
    /// Last known folder, as Windows shows it.
    pub folder: String,
    /// UTC in ISO 8601.
    pub last_opened_at: Option<String>,
    /// The folder still holds `.liurium/project.db`.
    pub present: bool,
}

/// All registered projects, the most recently opened first. Only checks whether each
/// folder still holds `project.db`: no project database is opened, so listing never
/// upgrades or writes anything.
pub fn list(app: &Connection) -> Result<Vec<Entry>, DbError> {
    let mut statement = app.prepare(
        "SELECT id, name, path, last_opened_at FROM projects
         ORDER BY last_opened_at IS NULL, last_opened_at DESC, name COLLATE NOCASE, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, name, folder, last_opened_at): (String, String, String, Option<String>) = row?;
        entries.push(Entry {
            present: holds_project(Path::new(&folder)),
            id,
            name,
            folder,
            last_opened_at,
        });
    }
    Ok(entries)
}

/// Every registered project's id and name, the most recently opened first (M4-001,
/// for search). Only the registry is read; no folder is looked at.
pub fn names(app: &Connection) -> Result<Vec<(String, String)>, DbError> {
    let mut statement = app.prepare(
        "SELECT id, name FROM projects
         ORDER BY last_opened_at IS NULL, last_opened_at DESC, name COLLATE NOCASE, id",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Sets the display name in `project.db`, where it travels with the folder (ADR-0016),
/// and in the registry's cache.
pub fn rename(app: &Connection, project: &mut Project, name: &str) -> Result<(), ProjectError> {
    let name = valid_name(name).ok_or(ProjectError::InvalidName)?;
    if project.read_only {
        return Err(DbError::ReadOnly.into());
    }
    project.connection.execute(
        "INSERT INTO meta (key, value) VALUES ('name', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [&name],
    )?;
    app.execute(
        "UPDATE projects SET name = ?2 WHERE id = ?1",
        params![project.id, name],
    )?;
    project.name = name;
    Ok(())
}

/// Forgets a project. Its folder is not touched; adding it again restores the project
/// with its identity and name.
pub fn remove(app: &Connection, id: &str) -> Result<(), ProjectError> {
    match app.execute("DELETE FROM projects WHERE id = ?1", [id])? {
        0 => Err(ProjectError::Unknown),
        _ => Ok(()),
    }
}

/// Points a registered project at the folder it moved to and opens it. The folder must
/// hold this very project; a folder without a project or with another one is refused
/// and the registry stays as it was.
pub fn locate(app: &Connection, id: &str, folder: &Path) -> Result<Project, ProjectError> {
    registered_path(app, id)?;
    let root = ProjectRoot::open(folder)?;
    if !root.suitable() {
        return Err(ProjectError::Unsuitable);
    }
    let project = match load(root) {
        Err(
            ProjectError::Fs(storage_fs::FsError::NotFound) | ProjectError::Db(DbError::Missing),
        ) => {
            return Err(ProjectError::NoProject);
        }
        loaded => loaded?,
    };
    if project.id != id {
        return Err(ProjectError::OtherProject);
    }
    register(app, &project)?;
    opened(app, &project)?;
    Ok(project)
}

fn registered_path(app: &Connection, id: &str) -> Result<String, ProjectError> {
    app.query_row("SELECT path FROM projects WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or(ProjectError::Unknown)
}

fn holds_project(folder: &Path) -> bool {
    ProjectRoot::open(folder)
        .and_then(|root| root.liurium_dir())
        .ok()
        .flatten()
        .is_some_and(|dir| dir.join(PROJECT_DB).is_file())
}

/// The most recently opened project: its id and the name the registry shows.
pub fn last_opened(app: &Connection) -> Result<Option<(String, String)>, DbError> {
    Ok(app
        .query_row(
            "SELECT id, name FROM projects WHERE last_opened_at IS NOT NULL
             ORDER BY last_opened_at DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// Records that the project's sync-folder warning is shown (M2-010). True only the first
/// time, so the warning comes once per project.
pub fn first_sync_warning(app: &Connection, id: &str) -> Result<bool, DbError> {
    let changed = app.execute(
        "UPDATE projects SET sync_warned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND sync_warned_at IS NULL",
        [id],
    )?;
    Ok(changed == 1)
}

/// How many projects have shown their sync-folder warning (M3-009).
pub fn sync_warned(app: &Connection) -> Result<usize, DbError> {
    let count: i64 = app.query_row(
        "SELECT count(*) FROM projects WHERE sync_warned_at IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(0))
}

/// Lets every project show its sync-folder warning once more (M3-009). Returns how
/// many projects were reset.
pub fn reset_sync_warnings(app: &Connection) -> Result<usize, DbError> {
    Ok(app.execute(
        "UPDATE projects SET sync_warned_at = NULL WHERE sync_warned_at IS NOT NULL",
        [],
    )?)
}

fn load(root: ProjectRoot) -> Result<Project, ProjectError> {
    let dir = root
        .liurium_dir()?
        .ok_or(ProjectError::Fs(storage_fs::FsError::NotFound))?;
    let connection = db::open(&dir.join(PROJECT_DB), Kind::Project, OpenMode::Existing)?;
    let id = meta(&connection, "id")?
        .filter(|id| is_project_id(id))
        .ok_or(ProjectError::Damaged)?;
    let name = meta(&connection, "name")?
        .map(|name| clean_name(&name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| default_name(&root));
    let read_only = connection.is_readonly(MAIN_DB)?;
    Ok(Project {
        id,
        name,
        root,
        read_only,
        connection,
    })
}

/// Creates `.liurium` (unless an empty one is there), `project.db` with a new
/// identity, and `.gitignore`. If any step fails, what this call created is removed.
fn create(root: ProjectRoot, existing: Option<PathBuf>) -> Result<Project, ProjectError> {
    let mut created = Created::default();
    let dir = match existing {
        Some(dir) => dir,
        None => {
            let dir = root.create_liurium_dir()?;
            created.dir = Some(dir.clone());
            dir
        }
    };
    let database = dir.join(PROJECT_DB);
    created.files.push(database.clone());
    let connection = db::open(&database, Kind::Project, OpenMode::CreateIfMissing)?;
    let id = new_id(&connection)?;
    let name = default_name(&root);
    connection.execute(
        "INSERT INTO meta (key, value) VALUES ('id', ?1), ('name', ?2)",
        params![id, name],
    )?;
    let gitignore = dir.join(".gitignore");
    if !gitignore.try_exists()? {
        created.files.push(gitignore.clone());
        storage_fs::create_file(&gitignore, GITIGNORE.as_bytes())?;
    }
    created.keep();
    Ok(Project {
        id,
        name,
        root,
        read_only: false,
        connection,
    })
}

/// What `create` made so far; removed on drop unless kept. The connection to
/// `project.db` is declared later in `create`, so it is closed before this runs.
#[derive(Default)]
struct Created {
    dir: Option<PathBuf>,
    files: Vec<PathBuf>,
}

impl Created {
    fn keep(mut self) {
        self.dir = None;
        self.files.clear();
    }
}

impl Drop for Created {
    fn drop(&mut self) {
        // Best effort, an error is already on its way. A folder made by this call holds
        // only files made by this call; `remove_dir_all` does not follow links.
        if let Some(dir) = &self.dir {
            let _ = fs::remove_dir_all(dir);
            return;
        }
        for file in &self.files {
            let _ = fs::remove_file(file);
            let mut journal = file.as_os_str().to_owned();
            journal.push("-journal");
            let _ = fs::remove_file(PathBuf::from(journal));
        }
    }
}

/// Records where the project is. A moved project (old folder gone) gets its new
/// path; a project still present in another folder is a copy and is refused.
fn register(app: &Connection, project: &Project) -> Result<(), ProjectError> {
    let known: Option<(String, String)> = app
        .query_row(
            "SELECT path, name FROM projects WHERE id = ?1",
            [&project.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((old, name)) = known {
        let path = Path::new(&old);
        let same = storage_fs::same_path(path, project.root.path()).unwrap_or(false);
        if !same && path.join(LIURIUM_DIR).join(PROJECT_DB).try_exists()? {
            return Err(ProjectError::Duplicate(Box::new(ProjectCopy {
                folder: project.root.path().to_owned(),
                display: project.root.display(),
                id: project.id.clone(),
                original_name: name,
                original_folder: old,
            })));
        }
    }
    app.execute(
        "INSERT INTO projects (id, path, name) VALUES (?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET path = excluded.path, name = excluded.name",
        params![project.id, project.root.display(), project.name],
    )?;
    Ok(())
}

/// After opening: remember the time and name, and remove temp files of interrupted
/// writes, unless the project is read-only.
fn opened(app: &Connection, project: &Project) -> Result<(), ProjectError> {
    app.execute(
        "UPDATE projects SET name = ?2,
         last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![project.id, project.name],
    )?;
    if !project.read_only {
        project.root.remove_temp_files();
    }
    Ok(())
}

fn meta(connection: &Connection, key: &str) -> Result<Option<String>, ProjectError> {
    Ok(connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn default_name(root: &ProjectRoot) -> String {
    root.name()
        .map(|name| clean_name(&name))
        .unwrap_or_default()
}

/// A name the user typed: trimmed, not empty, at most `MAX_NAME_CHARS`, and without
/// control characters. Refused rather than cleaned, so the user sees what is saved.
fn valid_name(name: &str) -> Option<String> {
    let name = name.trim();
    let valid = !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.chars().any(char::is_control);
    valid.then(|| name.to_owned())
}

/// No control characters, at most `MAX_NAME_CHARS`, trimmed.
fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A random UUID v4 from SQLite's `randomblob`, so no extra crate is needed.
fn new_id(connection: &Connection) -> Result<String, ProjectError> {
    let bytes: Vec<u8> = connection.query_row("SELECT randomblob(16)", [], |row| row.get(0))?;
    let mut bytes: [u8; 16] = bytes.try_into().map_err(|_| ProjectError::Damaged)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// A lowercase UUID v4, as `new_id` makes them. Ids from `project.db` are untrusted.
/// How a property shows, chosen by name for all notes of a project (M3-015).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "PropertyKind.ts"))]
pub enum PropertyKind {
    Text,
    List,
    Number,
    Checkbox,
    Date,
    DateTime,
}

impl PropertyKind {
    fn stored(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::List => "list",
            Self::Number => "number",
            Self::Checkbox => "checkbox",
            Self::Date => "date",
            Self::DateTime => "dateTime",
        }
    }

    fn from_stored(stored: &str) -> Option<Self> {
        [
            Self::Text,
            Self::List,
            Self::Number,
            Self::Checkbox,
            Self::Date,
            Self::DateTime,
        ]
        .into_iter()
        .find(|kind| kind.stored() == stored)
    }
}

impl Project {
    /// The kinds chosen in this project, by name. A write-protected project may still
    /// be at a version without them (it cannot be upgraded); it has none then.
    pub fn property_kinds(&self) -> Result<Vec<(String, PropertyKind)>, DbError> {
        property_kinds(&self.connection)
    }

    /// Chooses a kind for a name, or with `None` goes back to following the value.
    pub fn set_property_kind(&self, name: &str, kind: Option<PropertyKind>) -> Result<(), DbError> {
        set_property_kind(&self.connection, name, kind)
    }
}

fn property_kinds(conn: &Connection) -> Result<Vec<(String, PropertyKind)>, DbError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'property_kinds')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = conn.prepare("SELECT name, kind FROM property_kinds ORDER BY name")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut kinds = Vec::new();
    for row in rows {
        let (name, stored) = row?;
        // The file can come from anywhere; an unknown kind counts as not chosen.
        if let Some(kind) = PropertyKind::from_stored(&stored) {
            kinds.push((name, kind));
        }
    }
    Ok(kinds)
}

fn set_property_kind(
    conn: &Connection,
    name: &str,
    kind: Option<PropertyKind>,
) -> Result<(), DbError> {
    match kind {
        Some(kind) => conn.execute(
            "INSERT INTO property_kinds (name, kind) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET name = excluded.name, kind = excluded.kind",
            params![name, kind.stored()],
        )?,
        None => conn.execute("DELETE FROM property_kinds WHERE name = ?1", [name])?,
    };
    Ok(())
}

pub fn is_project_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
