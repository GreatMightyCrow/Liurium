import type { Board, Task, TaskPriority } from "../../lib/ipc/commands";
import { type Target, today } from "./board";

// What the filters on the board let through (M4-008). They only choose what is shown:
// the board from Rust stays whole, and a move is worked out against it.

export type DueChoice = "overdue" | "today" | "week" | "none";

export interface TaskFilter {
  text: string;
  tags: readonly string[];
  priorities: readonly TaskPriority[];
  due: readonly DueChoice[];
}

export const NO_FILTER: TaskFilter = {
  text: "",
  tags: [],
  priorities: [],
  due: [],
};

/** As many characters as Rust accepts for the search in descriptions. */
export const MAX_FILTER_TEXT = 200;

export function isFiltering(filter: TaskFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.tags.length > 0 ||
    filter.priorities.length > 0 ||
    filter.due.length > 0
  );
}

/** The last day of the week `day` is in; a week runs from Monday to Sunday. */
export function endOfWeek(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(year, month - 1, date);
  at.setDate(at.getDate() + ((7 - at.getDay()) % 7));
  return today(at);
}

function fitsDue(due: string | null, choice: DueChoice, day: string): boolean {
  switch (choice) {
    case "none":
      return due === null;
    case "overdue":
      return due !== null && due < day;
    case "today":
      return due === day;
    case "week":
      return due !== null && due >= day && due <= endOfWeek(day);
  }
}

function fitsText(
  task: Task,
  text: string,
  inDescription: ReadonlySet<string>,
): boolean {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") {
    return true;
  }
  const tag = wanted.replace(/^#/, "");
  return (
    task.title.toLowerCase().includes(wanted) ||
    task.tags.some((one) => one.toLowerCase().includes(tag)) ||
    inDescription.has(task.id)
  );
}

/** A task must fit every kind of filter; inside one kind, any choice will do. */
export function fits(
  task: Task,
  filter: TaskFilter,
  inDescription: ReadonlySet<string>,
  day: string,
): boolean {
  const chosen = filter.tags.map((tag) => tag.toLowerCase());
  return (
    fitsText(task, filter.text, inDescription) &&
    (chosen.length === 0 ||
      task.tags.some((tag) => chosen.includes(tag.toLowerCase()))) &&
    (filter.priorities.length === 0 ||
      filter.priorities.includes(task.priority)) &&
    (filter.due.length === 0 ||
      filter.due.some((choice) => fitsDue(task.due, choice, day)))
  );
}

/** The board to show; the same object when nothing is filtered. */
export function filteredBoard(
  board: Board,
  filter: TaskFilter,
  inDescription: ReadonlySet<string>,
  day: string,
): Board {
  if (!isFiltering(filter)) {
    return board;
  }
  return {
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter((task) =>
        fits(task, filter, inDescription, day),
      ),
    })),
  };
}

export function countTasks(board: Board): number {
  return board.columns.reduce((sum, column) => sum + column.tasks.length, 0);
}

/** A new task is the last of its column. */
export function lastTaskIn(board: Board, column: string): Task | undefined {
  const tasks = board.columns.find((one) => one.id === column)?.tasks ?? [];
  return tasks[tasks.length - 1];
}

/** Every tag on the board and every chosen one, one spelling each, sorted. */
export function tagChoices(board: Board, chosen: readonly string[]): string[] {
  const seen = new Map<string, string>();
  const tags = [
    ...chosen,
    ...board.columns.flatMap((column) =>
      column.tasks.flatMap((task) => task.tags),
    ),
  ];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * Where a move on the shown board goes in the whole column: right before the card it
 * was dropped on, or right after the last one shown. Hidden tasks stay as they are.
 * `null` when the card was put back where it was, as that must change nothing.
 */
export function storedTarget(
  board: Board,
  shown: Board,
  task: string,
  target: Target,
): Target | null {
  if (shown === board) {
    return target;
  }
  const whole = board.columns.find((one) => one.id === target.column);
  const seen = shown.columns.find((one) => one.id === target.column);
  if (whole === undefined || seen === undefined) {
    return null;
  }
  if (seen.tasks.findIndex((one) => one.id === task) === target.index) {
    return null;
  }
  const all = whole.tasks.filter((one) => one.id !== task);
  const others = seen.tasks.filter((one) => one.id !== task);
  const indexOf = (id: string) => all.findIndex((one) => one.id === id);
  const next = others[target.index] as Task | undefined;
  if (next !== undefined) {
    return { column: target.column, index: indexOf(next.id) };
  }
  const last = others[others.length - 1] as Task | undefined;
  return {
    column: target.column,
    index: last === undefined ? all.length : indexOf(last.id) + 1,
  };
}

// Kept until the app restarts, for each project, and never written anywhere.
const remembered = new Map<string, TaskFilter>();

export function rememberedFilter(project: string): TaskFilter {
  return remembered.get(project) ?? NO_FILTER;
}

export function rememberFilter(project: string, filter: TaskFilter): void {
  if (isFiltering(filter)) {
    remembered.set(project, filter);
  } else {
    remembered.delete(project);
  }
}

export function forgetFilters(): void {
  remembered.clear();
}
