import type { Board, Task } from "../../lib/ipc/commands";

// Where tasks are and where a key would take them (M4-004). Rust holds the order;
// this only shows a move at once and works out what to ask for.

export interface Place {
  column: number;
  index: number;
}

export interface Target {
  column: string;
  /** Counted without the task itself, as Rust counts it. */
  index: number;
}

export function placeOf(board: Board, task: string): Place | null {
  for (const [column, each] of board.columns.entries()) {
    const index = each.tasks.findIndex((one) => one.id === task);
    if (index >= 0) {
      return { column, index };
    }
  }
  return null;
}

export function taskIn(board: Board, id: string): Task | null {
  for (const column of board.columns) {
    const task = column.tasks.find((one) => one.id === id);
    if (task !== undefined) {
      return task;
    }
  }
  return null;
}

/** The board as it will be after a move, to show before Rust answers. */
export function movedTask(
  board: Board,
  id: string,
  column: string,
  index: number,
): Board {
  const task = taskIn(board, id);
  if (task === null || !board.columns.some((one) => one.id === column)) {
    return board;
  }
  return {
    columns: board.columns.map((each) => {
      const tasks = each.tasks.filter((one) => one.id !== id);
      if (each.id === column) {
        tasks.splice(Math.min(index, tasks.length), 0, task);
      }
      return { ...each, tasks };
    }),
  };
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function isArrowKey(key: string): key is ArrowKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}

/** Where Ctrl + an arrow moves a task; `null` when it is at that edge. */
export function keyboardTarget(
  board: Board,
  id: string,
  key: ArrowKey,
): Target | null {
  const place = placeOf(board, id);
  if (place === null) {
    return null;
  }
  const column = board.columns[place.column];
  if (key === "ArrowUp" || key === "ArrowDown") {
    const index = place.index + (key === "ArrowUp" ? -1 : 1);
    return index < 0 || index >= column.tasks.length
      ? null
      : { column: column.id, index };
  }
  const next = board.columns[place.column + (key === "ArrowLeft" ? -1 : 1)] as
    Board["columns"][number] | undefined;
  return next === undefined
    ? null
    : { column: next.id, index: Math.min(place.index, next.tasks.length) };
}

/** The task an arrow leads to; empty columns are stepped over. */
export function neighbour(
  board: Board,
  id: string,
  key: ArrowKey,
): string | null {
  const place = placeOf(board, id);
  if (place === null) {
    return null;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const tasks = board.columns[place.column].tasks;
    const task = tasks[place.index + (key === "ArrowUp" ? -1 : 1)] as
      Task | undefined;
    return task?.id ?? null;
  }
  const step = key === "ArrowLeft" ? -1 : 1;
  for (
    let column = place.column + step;
    column >= 0 && column < board.columns.length;
    column += step
  ) {
    const tasks = board.columns[column].tasks;
    if (tasks.length > 0) {
      return tasks[Math.min(place.index, tasks.length - 1)].id;
    }
  }
  return null;
}

/** The index a pointer at `y` stands for, given the cards' vertical middles. */
export function indexAt(middles: readonly number[], y: number): number {
  const below = middles.findIndex((middle) => y < middle);
  return below < 0 ? middles.length : below;
}

const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function dueLabel(due: string): string {
  const [year, month, day] = due.split("-").map(Number);
  return formatted.format(new Date(year, month - 1, day));
}

/** Today in the form dates are stored, on this computer's calendar. */
export function today(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${String(now.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}
