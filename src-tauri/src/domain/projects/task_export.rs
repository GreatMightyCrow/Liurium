//! The board as one Markdown file (M4-009), so a project's tasks can be read without
//! Liurium. It is a copy; nothing reads it back. Task text can hold anything, also what
//! Markdown would act on, so none of it is written as Markdown: a title is escaped, a
//! tag or path is a code span, a description a code block with a longer fence than any
//! run of backticks in it. The file holds no date, so an unchanged board gives the same
//! file and exporting twice has nothing to ask.

use std::fmt::Write as _;

use super::{
    Project,
    tasks::{Board, Priority, Task, TaskError},
};

/// The name proposed for the file, and the one used inside the project.
pub const EXPORT_NAME: &str = "Tasks export.md";

/// Far beyond any real board, but 10 000 tasks of 1 MB would not fit in memory.
const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

/// What can start or end something in Markdown or in Liurium's own additions to it.
const ACTIVE: &str = "\\`*_{}[]()#+|<>~$&%=^";

/// One line of text that means only itself.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_control() {
            out.push(' ');
        } else {
            if ACTIVE.contains(c) {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}

fn longest_backticks(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

/// One line of text as a code span, closed only by its own run of backticks.
fn code_span(text: &str) -> String {
    let line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let longest = longest_backticks(&line);
    if longest == 0 {
        return format!("`{line}`");
    }
    let ticks = "`".repeat(longest + 1);
    format!("{ticks} {line} {ticks}")
}

fn priority_name(priority: Priority) -> Option<&'static str> {
    match priority {
        Priority::None => None,
        Priority::Low => Some("Low"),
        Priority::Medium => Some("Medium"),
        Priority::High => Some("High"),
    }
}

fn code_list<'a>(items: impl Iterator<Item = &'a String>) -> String {
    items
        .filter(|item| !item.is_empty())
        .map(|item| code_span(item))
        .collect::<Vec<_>>()
        .join(", ")
}

fn write_description(out: &mut String, description: &str) {
    let text: String = description
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .map(|c| {
            if c.is_control() && !matches!(c, '\n' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let text = text.trim_end();
    if text.trim().is_empty() {
        return;
    }
    let fence = "`".repeat(longest_backticks(text).max(2) + 1);
    let _ = write!(out, "{fence}text\n{text}\n{fence}\n\n");
}

fn write_task(out: &mut String, task: &Task, description: Option<&String>) {
    let _ = write!(out, "### {}\n\n", plain(&task.title));
    let mut facts = Vec::new();
    if let Some(priority) = priority_name(task.priority) {
        facts.push(format!("Priority: {priority}"));
    }
    if let Some(due) = &task.due {
        facts.push(format!("Due: {due}"));
    }
    let tags: Vec<String> = task
        .tags
        .iter()
        .filter(|tag| !tag.is_empty())
        .map(|tag| format!("#{tag}"))
        .collect();
    if !tags.is_empty() {
        facts.push(format!("Tags: {}", code_list(tags.iter())));
    }
    let notes = code_list(task.notes.iter());
    if !notes.is_empty() {
        facts.push(format!("Notes: {notes}"));
    }
    for fact in &facts {
        let _ = writeln!(out, "- {fact}");
    }
    if !facts.is_empty() {
        out.push('\n');
    }
    if let Some(description) = description {
        write_description(out, description);
    }
}

/// The whole file. `max` is the most it may come to.
pub(super) fn render(
    name: &str,
    board: &Board,
    description: impl Fn(&str) -> Option<String>,
    max: usize,
) -> Result<String, TaskError> {
    let mut out = format!(
        "# Tasks of {}\n\nExported from Liurium. This is a copy: changes here do not change the tasks.\n\n",
        plain(name)
    );
    for column in &board.columns {
        let _ = write!(out, "## {}\n\n", plain(&column.name));
        if column.tasks.is_empty() {
            out.push_str("No tasks.\n\n");
        }
        for task in &column.tasks {
            let text = description(&task.id);
            write_task(&mut out, task, text.as_ref());
            if out.len() > max {
                return Err(TaskError::Limit);
            }
        }
    }
    out.truncate(out.trim_end().len());
    out.push('\n');
    Ok(out)
}

impl Project {
    /// The board as it is now, without the trash, in the board's order.
    pub fn tasks_markdown(&self) -> Result<String, TaskError> {
        let board = self.task_board()?;
        let descriptions = self.live_descriptions(MAX_EXPORT_BYTES)?;
        render(
            &self.name,
            &board,
            |id| descriptions.get(id).cloned(),
            MAX_EXPORT_BYTES,
        )
    }
}
