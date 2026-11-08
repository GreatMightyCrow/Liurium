import { expect, test } from "vitest";
import type { Board, Task } from "../../lib/ipc/commands";
import {
  indexAt,
  isArrowKey,
  keyboardTarget,
  movedTask,
  neighbour,
  placeOf,
  today,
} from "./board";

function task(id: string): Task {
  return {
    id,
    title: id,
    hasDescription: false,
    priority: "none",
    due: null,
    tags: [],
    notes: [],
    createdMs: 0,
    updatedMs: 0,
    trashedMs: null,
  };
}

const BOARD: Board = {
  columns: [
    { id: "a", name: "A", tasks: [task("1"), task("2"), task("3")] },
    { id: "empty", name: "Empty", tasks: [] },
    { id: "b", name: "B", tasks: [task("4")] },
  ],
};

const order = (board: Board) =>
  board.columns.map((column) => column.tasks.map((one) => one.id));

test("a move shows at once, counted without the task", () => {
  expect(order(movedTask(BOARD, "3", "a", 0))).toEqual([
    ["3", "1", "2"],
    [],
    ["4"],
  ]);
  expect(order(movedTask(BOARD, "1", "a", 1))).toEqual([
    ["2", "1", "3"],
    [],
    ["4"],
  ]);
  expect(order(movedTask(BOARD, "1", "b", 99))).toEqual([
    ["2", "3"],
    [],
    ["4", "1"],
  ]);
});

test("a move of something unknown changes nothing", () => {
  expect(movedTask(BOARD, "nope", "a", 0)).toBe(BOARD);
  expect(movedTask(BOARD, "1", "nope", 0)).toBe(BOARD);
});

test("Ctrl + arrows stop at the edges", () => {
  expect(keyboardTarget(BOARD, "1", "ArrowUp")).toBeNull();
  expect(keyboardTarget(BOARD, "3", "ArrowDown")).toBeNull();
  expect(keyboardTarget(BOARD, "1", "ArrowLeft")).toBeNull();
  expect(keyboardTarget(BOARD, "4", "ArrowRight")).toBeNull();
  expect(keyboardTarget(BOARD, "2", "ArrowUp")).toEqual({
    column: "a",
    index: 0,
  });
  expect(keyboardTarget(BOARD, "2", "ArrowDown")).toEqual({
    column: "a",
    index: 2,
  });
});

test("Ctrl + a side arrow goes to the very next column, also an empty one", () => {
  expect(keyboardTarget(BOARD, "3", "ArrowRight")).toEqual({
    column: "empty",
    index: 0,
  });
});

test("plain arrows walk through cards and step over empty columns", () => {
  expect(neighbour(BOARD, "1", "ArrowDown")).toBe("2");
  expect(neighbour(BOARD, "2", "ArrowUp")).toBe("1");
  expect(neighbour(BOARD, "1", "ArrowUp")).toBeNull();
  expect(neighbour(BOARD, "3", "ArrowRight")).toBe("4");
  expect(neighbour(BOARD, "4", "ArrowLeft")).toBe("1");
  expect(neighbour(BOARD, "4", "ArrowRight")).toBeNull();
});

test("the unknown has no place", () => {
  expect(placeOf(BOARD, "nope")).toBeNull();
  expect(keyboardTarget(BOARD, "nope", "ArrowUp")).toBeNull();
  expect(neighbour(BOARD, "nope", "ArrowUp")).toBeNull();
});

test("a pointer lands before the first card whose middle is below it", () => {
  expect(indexAt([], 50)).toBe(0);
  expect(indexAt([10, 30], 5)).toBe(0);
  expect(indexAt([10, 30], 20)).toBe(1);
  expect(indexAt([10, 30], 40)).toBe(2);
});

test("only the four arrows count", () => {
  expect(isArrowKey("ArrowLeft")).toBe(true);
  expect(isArrowKey("Enter")).toBe(false);
});

test("today is written as dates are stored", () => {
  expect(today(new Date(2026, 0, 5))).toBe("2026-01-05");
});
