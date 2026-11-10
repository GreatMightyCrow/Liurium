//! The tasks of a project, in its `project.db` (ADR-0004, M4-003). Every change is one
//! transaction. The file travels with the folder and can come from anywhere, so what is
//! read is checked as well: a bad value counts as not set and never stops the board.
//! Task text is never logged.

use std::{
    collections::HashMap,
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::{Project, ProjectError, new_id};
use crate::domain::notes::{
    links::valid_tag,
    organize::{entry_path, is_note_name},
};
use crate::storage::{
    db::DbError,
    fs::{FsError, ProjectRoot},
};

const MAX_TITLE_CHARS: usize = 500;
const MAX_DESCRIPTION_BYTES: usize = 1_048_576;
/// As other names in Liurium, so the same message fits.
const MAX_COLUMN_NAME_CHARS: usize = 200;
const MAX_COLUMNS: i64 = 100;
/// With the trash.
const MAX_TASKS: i64 = 10_000;
const MAX_TAGS: usize = 50;
const MAX_TAG_CHARS: usize = 100;
const MAX_NOTES: usize = 100;
/// What the board's filter can ask for.
const MAX_FILTER_CHARS: usize = 200;

/// Why a task or column could not be changed. Nothing was changed.
#[derive(Debug)]
pub enum TaskError {
    Project(ProjectError),
    /// No such task or column, or a task in the wrong place for this (live or trashed).
    NotFound,
    /// A title, text, or date outside the rules.
    Invalid,
    InvalidColumnName,
    InvalidTag,
    /// Too many tasks, columns, tags, or links.
    Limit,
    /// The column still holds tasks, or is the last one.
    ColumnInUse,
}

impl fmt::Display for TaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Project(error) => write!(f, "{error}"),
            Self::NotFound => write!(f, "no such task or column"),
            Self::Invalid => write!(f, "the task has a title, text, or date outside the rules"),
            Self::InvalidColumnName => write!(f, "the column name is outside the rules"),
            Self::InvalidTag => write!(f, "the tag is outside the rules"),
            Self::Limit => write!(f, "the limit for tasks, columns, tags, or links is reached"),
            Self::ColumnInUse => write!(f, "the column holds tasks or is the last one"),
        }
    }
}

impl Error for TaskError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Project(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProjectError> for TaskError {
    fn from(error: ProjectError) -> Self {
        Self::Project(error)
    }
}

impl From<DbError> for TaskError {
    fn from(error: DbError) -> Self {
        Self::Project(error.into())
    }
}

impl From<FsError> for TaskError {
    fn from(error: FsError) -> Self {
        Self::Project(error.into())
    }
}

impl From<rusqlite::Error> for TaskError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Project(error.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "TaskPriority.ts"))]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
}

impl Priority {
    fn stored(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    fn from_stored(stored: &str) -> Self {
        [Self::Low, Self::Medium, Self::High]
            .into_iter()
            .find(|priority| priority.stored() == stored)
            .unwrap_or(Self::None)
    }
}

/// What the page sends for a new or changed task. The whole task, each time.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "TaskFields.ts"))]
pub struct TaskFields {
    pub title: String,
    pub description: String,
    pub priority: Priority,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    pub tags: Vec<String>,
    /// Paths of notes in the project.
    pub notes: Vec<String>,
}

/// A task without its description, so a board stays small.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "Task.ts"))]
pub struct Task {
    pub id: String,
    pub title: String,
    pub has_description: bool,
    pub priority: Priority,
    pub due: Option<String>,
    pub tags: Vec<String>,
    pub notes: Vec<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub created_ms: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub updated_ms: i64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub trashed_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "TaskDetail.ts"))]
pub struct TaskDetail {
    pub task: Task,
    /// The id of its column; a trashed task keeps it.
    pub column: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "BoardColumn.ts"))]
pub struct BoardColumn {
    pub id: String,
    pub name: String,
    /// In their order, top first.
    pub tasks: Vec<Task>,
}

/// The columns in their order, with their live tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "Board.ts"))]
pub struct Board {
    pub columns: Vec<BoardColumn>,
}

/// `TaskFields` after the rules: what may be written.
struct Checked {
    title: String,
    description: String,
    priority: Priority,
    due: Option<String>,
    tags: Vec<String>,
    notes: Vec<String>,
}

/// `known` are the links the task has already: a note gone since then stays linked.
fn checked(fields: TaskFields, root: &ProjectRoot, known: &[String]) -> Result<Checked, TaskError> {
    let title = fields.title.trim().to_owned();
    let title_fits = !title.is_empty()
        && title.chars().count() <= MAX_TITLE_CHARS
        && !title.chars().any(char::is_control);
    let description_fits = fields.description.len() <= MAX_DESCRIPTION_BYTES
        && !fields
            .description
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'));
    let due_fits = fields.due.as_deref().is_none_or(is_date);
    if !title_fits || !description_fits || !due_fits {
        return Err(TaskError::Invalid);
    }

    let mut tags: Vec<String> = Vec::new();
    for tag in fields.tags {
        if !valid_tag(&tag) || tag.chars().count() > MAX_TAG_CHARS {
            return Err(TaskError::InvalidTag);
        }
        if !tags
            .iter()
            .any(|seen| seen.to_lowercase() == tag.to_lowercase())
        {
            tags.push(tag);
        }
    }
    if tags.len() > MAX_TAGS {
        return Err(TaskError::Limit);
    }

    let mut notes: Vec<String> = Vec::new();
    for note in fields.notes {
        let path = if known.contains(&note) {
            note
        } else {
            existing_note(&note, root)?
        };
        if !notes
            .iter()
            .any(|seen| seen.to_lowercase() == path.to_lowercase())
        {
            notes.push(path);
        }
    }
    if notes.len() > MAX_NOTES {
        return Err(TaskError::Limit);
    }

    Ok(Checked {
        title,
        description: fields.description,
        priority: fields.priority,
        due: fields.due,
        tags,
        notes,
    })
}

/// A note of the tree that is there now, by the same rules as renaming one.
fn existing_note(text: &str, root: &ProjectRoot) -> Result<String, TaskError> {
    let path = entry_path(text)?;
    if !is_note_name(path.file_name()) || root.is_folder(&path)? {
        return Err(FsError::WrongKind.into());
    }
    Ok(path.to_string())
}

/// `YYYY-MM-DD`, a day that exists.
fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }
    let number = |from: usize, to: usize| text[from..to].parse::<u32>().unwrap_or(0);
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && (1..=days).contains(&day)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| i64::try_from(time.as_millis()).ok())
        .unwrap_or(0)
}

/// Text from the file, also when it is not valid UTF-8.
fn text(row: &Row<'_>, index: usize) -> rusqlite::Result<String> {
    Ok(String::from_utf8_lossy(row.get_ref(index)?.as_bytes()?).into_owned())
}

fn optional_text(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<String>> {
    match row.get_ref(index)? {
        rusqlite::types::ValueRef::Null => Ok(None),
        _ => text(row, index).map(Some),
    }
}

/// A write-protected project at an older version cannot be upgraded and has no tasks.
fn has_tasks(conn: &Connection) -> Result<bool, TaskError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks')",
        [],
        |row| row.get(0),
    )?)
}

fn write<T>(
    conn: &Connection,
    work: impl FnOnce(&Transaction<'_>) -> Result<T, TaskError>,
) -> Result<T, TaskError> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let result = work(&transaction)?;
    transaction.commit()?;
    Ok(result)
}

/// One column of labels (tags or note paths) by task, a capped number each.
fn labels(
    conn: &Connection,
    sql: &str,
    max: usize,
) -> Result<HashMap<String, Vec<String>>, TaskError> {
    let mut found: HashMap<String, Vec<String>> = HashMap::new();
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let list = found.entry(text(row, 0)?).or_default();
        if list.len() < max {
            list.push(text(row, 1)?);
        }
    }
    Ok(found)
}

/// Tasks that fit `clause`, fixed text, each with the id of its column.
fn tasks_where(
    conn: &Connection,
    clause: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<(String, Task)>, TaskError> {
    let mut tags = labels(
        conn,
        "SELECT task_id, tag FROM task_tags ORDER BY task_id, tag",
        MAX_TAGS,
    )?;
    let mut notes = labels(
        conn,
        "SELECT task_id, path FROM task_notes ORDER BY task_id, path",
        MAX_NOTES,
    )?;
    let mut statement = conn.prepare(&format!(
        "SELECT id, column_id, substr(title, 1, {MAX_TITLE_CHARS}), length(description) > 0,
                priority, due, created_ms, updated_ms, trashed_ms
         FROM tasks WHERE {clause} LIMIT {MAX_TASKS}"
    ))?;
    let mut rows = statement.query(values)?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next()? {
        let id = text(row, 0)?;
        let task = Task {
            title: text(row, 2)?,
            has_description: row.get(3)?,
            priority: Priority::from_stored(&text(row, 4)?),
            due: optional_text(row, 5)?.filter(|due| is_date(due)),
            tags: tags.remove(&id).unwrap_or_default(),
            notes: notes.remove(&id).unwrap_or_default(),
            created_ms: row.get(6)?,
            updated_ms: row.get(7)?,
            trashed_ms: row.get(8)?,
            id,
        };
        tasks.push((text(row, 1)?, task));
    }
    Ok(tasks)
}

fn board(conn: &Connection) -> Result<Board, TaskError> {
    if !has_tasks(conn)? {
        return Ok(Board {
            columns: Vec::new(),
        });
    }
    let mut columns = Vec::new();
    {
        let mut statement = conn.prepare(&format!(
            "SELECT id, substr(name, 1, {MAX_COLUMN_NAME_CHARS}) FROM task_columns
             ORDER BY position, id LIMIT {MAX_COLUMNS}"
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            columns.push(BoardColumn {
                id: text(row, 0)?,
                name: text(row, 1)?,
                tasks: Vec::new(),
            });
        }
    }
    let live = tasks_where(
        conn,
        "trashed_ms IS NULL ORDER BY position, created_ms, id",
        [],
    )?;
    for (column, task) in live {
        // A task in a column that is gone shows in the first one.
        let at = columns
            .iter()
            .position(|each| each.id == column)
            .unwrap_or(0);
        if let Some(each) = columns.get_mut(at) {
            each.tasks.push(task);
        }
    }
    Ok(Board { columns })
}

/// Puts `moved` at `index` of `order` and numbers them; only rows that differ are written.
fn renumber(
    transaction: &Transaction<'_>,
    update: &str,
    mut order: Vec<String>,
    moved: &str,
    index: usize,
) -> Result<(), TaskError> {
    order.retain(|id| id != moved);
    order.insert(index.min(order.len()), moved.to_owned());
    let mut statement = transaction.prepare(update)?;
    for (position, id) in order.iter().enumerate() {
        statement.execute(params![i64::try_from(position).unwrap_or(i64::MAX), id])?;
    }
    Ok(())
}

fn ids(transaction: &Transaction<'_>, sql: &str, column: &str) -> Result<Vec<String>, TaskError> {
    let mut statement = transaction.prepare(sql)?;
    let mut rows = statement.query([column])?;
    let mut found = Vec::new();
    while let Some(row) = rows.next()? {
        found.push(text(row, 0)?);
    }
    Ok(found)
}

/// Places a task in its column's order. Numbers are whole and renumbered each time, so
/// any number of moves leaves them exact.
fn place(
    transaction: &Transaction<'_>,
    column: &str,
    task: &str,
    index: usize,
) -> Result<(), TaskError> {
    let order = ids(
        transaction,
        "SELECT id FROM tasks WHERE column_id = ?1 AND trashed_ms IS NULL
         ORDER BY position, created_ms, id",
        column,
    )?;
    renumber(
        transaction,
        "UPDATE tasks SET position = ?1 WHERE id = ?2 AND position <> ?1",
        order,
        task,
        index,
    )
}

fn place_column(
    transaction: &Transaction<'_>,
    column: &str,
    index: usize,
) -> Result<(), TaskError> {
    let mut order = Vec::new();
    {
        let mut statement =
            transaction.prepare("SELECT id FROM task_columns ORDER BY position, id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            order.push(text(row, 0)?);
        }
    }
    renumber(
        transaction,
        "UPDATE task_columns SET position = ?1 WHERE id = ?2 AND position <> ?1",
        order,
        column,
        index,
    )
}

fn column_exists(conn: &Connection, column: &str) -> Result<bool, TaskError> {
    Ok(conn
        .query_row("SELECT 1 FROM task_columns WHERE id = ?1", [column], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

fn require_column(conn: &Connection, column: &str) -> Result<(), TaskError> {
    if column_exists(conn, column)? {
        Ok(())
    } else {
        Err(TaskError::NotFound)
    }
}

fn require_live(conn: &Connection, task: &str) -> Result<(), TaskError> {
    conn.query_row(
        "SELECT 1 FROM tasks WHERE id = ?1 AND trashed_ms IS NULL",
        [task],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(TaskError::NotFound)
}

fn first_column(conn: &Connection) -> Result<Option<String>, TaskError> {
    Ok(conn
        .query_row(
            "SELECT id FROM task_columns ORDER BY position, id LIMIT 1",
            [],
            |row| text(row, 0),
        )
        .optional()?)
}

fn write_labels(
    transaction: &Transaction<'_>,
    task: &str,
    input: &Checked,
) -> Result<(), TaskError> {
    transaction.execute("DELETE FROM task_tags WHERE task_id = ?1", [task])?;
    transaction.execute("DELETE FROM task_notes WHERE task_id = ?1", [task])?;
    for tag in &input.tags {
        transaction.execute(
            "INSERT INTO task_tags (task_id, tag) VALUES (?1, ?2)",
            params![task, tag],
        )?;
    }
    for note in &input.notes {
        transaction.execute(
            "INSERT INTO task_notes (task_id, path) VALUES (?1, ?2)",
            params![task, note],
        )?;
    }
    Ok(())
}

fn column_name(name: &str) -> Result<String, TaskError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_COLUMN_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(TaskError::InvalidColumnName);
    }
    Ok(name.to_owned())
}

impl Project {
    pub fn task_board(&self) -> Result<Board, TaskError> {
        board(&self.connection)
    }

    /// The trash, last trashed first.
    pub fn trashed_tasks(&self) -> Result<Vec<Task>, TaskError> {
        if !has_tasks(&self.connection)? {
            return Ok(Vec::new());
        }
        Ok(tasks_where(
            &self.connection,
            "trashed_ms IS NOT NULL ORDER BY trashed_ms DESC, id",
            [],
        )?
        .into_iter()
        .map(|(_, task)| task)
        .collect())
    }

    pub fn task_detail(&self, task: &str) -> Result<TaskDetail, TaskError> {
        let conn = &self.connection;
        if !has_tasks(conn)? {
            return Err(TaskError::NotFound);
        }
        let (column, description): (String, String) = conn
            .query_row(
                &format!(
                    "SELECT column_id, substr(description, 1, {MAX_DESCRIPTION_BYTES})
                     FROM tasks WHERE id = ?1"
                ),
                [task],
                |row| Ok((text(row, 0)?, text(row, 1)?)),
            )
            .optional()?
            .ok_or(TaskError::NotFound)?;
        let (_, found) = tasks_where(conn, "id = ?1", [task])?
            .into_iter()
            .next()
            .ok_or(TaskError::NotFound)?;
        Ok(TaskDetail {
            task: found,
            column,
            description,
        })
    }

    /// The ids of the tasks on the board whose description holds `query`, in any case.
    /// In Rust and not with `LIKE`, which only folds ASCII letters.
    pub fn tasks_with_description(&self, query: &str) -> Result<Vec<String>, TaskError> {
        let wanted = query.trim();
        if wanted.chars().count() > MAX_FILTER_CHARS {
            return Err(TaskError::Invalid);
        }
        if wanted.is_empty() || !has_tasks(&self.connection)? {
            return Ok(Vec::new());
        }
        let wanted = wanted.to_lowercase();
        let mut statement = self.connection.prepare(&format!(
            "SELECT id, substr(description, 1, {MAX_DESCRIPTION_BYTES}) FROM tasks
             WHERE trashed_ms IS NULL AND length(description) > 0 LIMIT {MAX_TASKS}"
        ))?;
        let mut rows = statement.query([])?;
        let mut found = Vec::new();
        while let Some(row) = rows.next()? {
            if text(row, 1)?.to_lowercase().contains(&wanted) {
                found.push(text(row, 0)?);
            }
        }
        Ok(found)
    }

    /// The descriptions of the tasks on the board by id, at most `max` bytes in all.
    pub(super) fn live_descriptions(
        &self,
        max: usize,
    ) -> Result<HashMap<String, String>, TaskError> {
        let mut found = HashMap::new();
        if !has_tasks(&self.connection)? {
            return Ok(found);
        }
        let mut statement = self.connection.prepare(&format!(
            "SELECT id, substr(description, 1, {MAX_DESCRIPTION_BYTES}) FROM tasks
             WHERE trashed_ms IS NULL AND length(description) > 0 LIMIT {MAX_TASKS}"
        ))?;
        let mut rows = statement.query([])?;
        let mut total = 0_usize;
        while let Some(row) = rows.next()? {
            let description = text(row, 1)?;
            total = total.saturating_add(description.len());
            if total > max {
                return Err(TaskError::Limit);
            }
            found.insert(text(row, 0)?, description);
        }
        Ok(found)
    }

    /// A new task at the bottom of its column.
    pub fn create_task(&self, column: &str, fields: TaskFields) -> Result<Board, TaskError> {
        let input = checked(fields, &self.root, &[])?;
        write(&self.connection, |transaction| {
            require_column(transaction, column)?;
            let total: i64 =
                transaction.query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))?;
            if total >= MAX_TASKS {
                return Err(TaskError::Limit);
            }
            let id = new_id(transaction)?;
            let now = now_ms();
            transaction.execute(
                "INSERT INTO tasks
                     (id, column_id, position, title, description, priority, due, created_ms, updated_ms)
                 VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    column,
                    input.title,
                    input.description,
                    input.priority.stored(),
                    input.due,
                    now
                ],
            )?;
            write_labels(transaction, &id, &input)?;
            place(transaction, column, &id, usize::MAX)
        })?;
        board(&self.connection)
    }

    pub fn update_task(&self, task: &str, fields: TaskFields) -> Result<Board, TaskError> {
        let conn = &self.connection;
        require_live(conn, task)?;
        let known = linked_notes(conn, task)?;
        let input = checked(fields, &self.root, &known)?;
        write(conn, |transaction| {
            let changed = transaction.execute(
                "UPDATE tasks SET title = ?2, description = ?3, priority = ?4, due = ?5, updated_ms = ?6
                 WHERE id = ?1 AND trashed_ms IS NULL",
                params![
                    task,
                    input.title,
                    input.description,
                    input.priority.stored(),
                    input.due,
                    now_ms()
                ],
            )?;
            if changed == 0 {
                return Err(TaskError::NotFound);
            }
            write_labels(transaction, task, &input)
        })?;
        board(conn)
    }

    /// To `index` of `column`, counted without the task itself; past the end is the end.
    pub fn move_task(&self, task: &str, column: &str, index: u32) -> Result<Board, TaskError> {
        write(&self.connection, |transaction| {
            require_live(transaction, task)?;
            require_column(transaction, column)?;
            transaction.execute(
                "UPDATE tasks SET column_id = ?1, updated_ms = ?2 WHERE id = ?3 AND column_id <> ?1",
                params![column, now_ms(), task],
            )?;
            place(
                transaction,
                column,
                task,
                usize::try_from(index).unwrap_or(usize::MAX),
            )
        })?;
        board(&self.connection)
    }

    pub fn trash_task(&self, task: &str) -> Result<Board, TaskError> {
        let changed = self.connection.execute(
            "UPDATE tasks SET trashed_ms = ?1 WHERE id = ?2 AND trashed_ms IS NULL",
            params![now_ms(), task],
        )?;
        if changed == 0 {
            return Err(TaskError::NotFound);
        }
        board(&self.connection)
    }

    /// Back at the bottom of its column, or of the first one when its column is gone.
    pub fn restore_task(&self, task: &str) -> Result<Board, TaskError> {
        write(&self.connection, |transaction| {
            let column: String = transaction
                .query_row(
                    "SELECT column_id FROM tasks WHERE id = ?1 AND trashed_ms IS NOT NULL",
                    [task],
                    |row| text(row, 0),
                )
                .optional()?
                .ok_or(TaskError::NotFound)?;
            let target = if column_exists(transaction, &column)? {
                column
            } else {
                first_column(transaction)?.ok_or(TaskError::NotFound)?
            };
            transaction.execute(
                "UPDATE tasks SET trashed_ms = NULL, column_id = ?1, updated_ms = ?2 WHERE id = ?3",
                params![target, now_ms(), task],
            )?;
            place(transaction, &target, task, usize::MAX)
        })?;
        board(&self.connection)
    }

    /// Gone for good; only from the trash.
    pub fn delete_task(&self, task: &str) -> Result<(), TaskError> {
        let changed = self.connection.execute(
            "DELETE FROM tasks WHERE id = ?1 AND trashed_ms IS NOT NULL",
            [task],
        )?;
        if changed == 0 {
            return Err(TaskError::NotFound);
        }
        Ok(())
    }

    /// A new column at the end.
    pub fn create_column(&self, name: &str) -> Result<Board, TaskError> {
        let name = column_name(name)?;
        write(&self.connection, |transaction| {
            let total: i64 =
                transaction.query_row("SELECT count(*) FROM task_columns", [], |row| row.get(0))?;
            if total >= MAX_COLUMNS {
                return Err(TaskError::Limit);
            }
            let id = new_id(transaction)?;
            transaction.execute(
                "INSERT INTO task_columns (id, name, position) VALUES (?1, ?2, ?3)",
                params![id, name, total],
            )?;
            place_column(transaction, &id, usize::MAX)
        })?;
        board(&self.connection)
    }

    pub fn rename_column(&self, column: &str, name: &str) -> Result<Board, TaskError> {
        let name = column_name(name)?;
        let changed = self.connection.execute(
            "UPDATE task_columns SET name = ?1 WHERE id = ?2",
            params![name, column],
        )?;
        if changed == 0 {
            return Err(TaskError::NotFound);
        }
        board(&self.connection)
    }

    pub fn move_column(&self, column: &str, index: u32) -> Result<Board, TaskError> {
        write(&self.connection, |transaction| {
            require_column(transaction, column)?;
            place_column(
                transaction,
                column,
                usize::try_from(index).unwrap_or(usize::MAX),
            )
        })?;
        board(&self.connection)
    }

    /// Only an empty column, and never the last. Its trashed tasks move to the first
    /// column that stays, so they can still be restored.
    pub fn delete_column(&self, column: &str) -> Result<Board, TaskError> {
        write(&self.connection, |transaction| {
            require_column(transaction, column)?;
            let total: i64 =
                transaction.query_row("SELECT count(*) FROM task_columns", [], |row| row.get(0))?;
            let live: i64 = transaction.query_row(
                "SELECT count(*) FROM tasks WHERE column_id = ?1 AND trashed_ms IS NULL",
                [column],
                |row| row.get(0),
            )?;
            if total <= 1 || live > 0 {
                return Err(TaskError::ColumnInUse);
            }
            let heir: String = transaction.query_row(
                "SELECT id FROM task_columns WHERE id <> ?1 ORDER BY position, id LIMIT 1",
                [column],
                |row| text(row, 0),
            )?;
            transaction.execute(
                "UPDATE tasks SET column_id = ?1 WHERE column_id = ?2",
                params![heir, column],
            )?;
            transaction.execute("DELETE FROM task_columns WHERE id = ?1", [column])?;
            Ok(())
        })?;
        board(&self.connection)
    }

    /// A note or folder was renamed or moved inside Liurium: links follow it.
    pub fn notes_moved(&self, from: &str, to: &str) -> Result<(), TaskError> {
        if !has_tasks(&self.connection)? {
            return Ok(());
        }
        self.connection.execute(
            "UPDATE OR REPLACE task_notes SET path = ?2 || substr(path, length(?1) + 1)
             WHERE path = ?1 COLLATE NOCASE
                OR substr(path, 1, length(?1) + 1) = ?1 || '/' COLLATE NOCASE",
            params![from, to],
        )?;
        Ok(())
    }
}

fn linked_notes(conn: &Connection, task: &str) -> Result<Vec<String>, TaskError> {
    let mut statement = conn.prepare("SELECT path FROM task_notes WHERE task_id = ?1")?;
    let mut rows = statement.query([task])?;
    let mut found = Vec::new();
    while let Some(row) = rows.next()? {
        found.push(text(row, 0)?);
    }
    Ok(found)
}
