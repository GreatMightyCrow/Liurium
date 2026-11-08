import { afterEach, describe, expect, test } from "vitest";
import type { Board, Task } from "../../lib/ipc/commands";
import { today } from "./board";
import {
  countTasks,
  endOfWeek,
  filteredBoard,
  fits,
  forgetFilters,
  isFiltering,
  lastTaskIn,
  NO_FILTER,
  rememberedFilter,
  rememberFilter,
  storedTarget,
  tagChoices,
  type TaskFilter,
} from "./filter";

function task(id: string, more: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    hasDescription: false,
    priority: "none",
    due: null,
    tags: [],
    notes: [],
    createdMs: 0,
    updatedMs: 0,
    trashedMs: null,
    ...more,
  };
}

const NOTHING = new Set<string>();
const DAY = "2026-11-11"; // A Wednesday.

const check = (one: Task, filter: Partial<TaskFilter>, found = NOTHING) =>
  fits(one, { ...NO_FILTER, ...filter }, found, DAY);

function column(id: string, ...tasks: string[]) {
  return { id, name: id, tasks: tasks.map((one) => task(one)) };
}

afterEach(() => {
  forgetFilters();
});

describe("isFiltering", () => {
  test("is off for nothing and for blank text", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, text: "   " })).toBe(false);
  });

  test.each<Partial<TaskFilter>>([
    { text: "a" },
    { tags: ["a"] },
    { priorities: ["none"] },
    { due: ["none"] },
  ])("is on for %j", (filter) => {
    expect(isFiltering({ ...NO_FILTER, ...filter })).toBe(true);
  });
});

describe("the text filter", () => {
  test("looks in the title in any case", () => {
    expect(check(task("1", { title: "Fix the ROOF" }), { text: "roof" })).toBe(
      true,
    );
    expect(check(task("1", { title: "Äpfel" }), { text: "äPFEL" })).toBe(true);
    expect(check(task("1", { title: "Fix" }), { text: "roof" })).toBe(false);
  });

  test("looks in tags, with or without the hash", () => {
    const one = task("1", { tags: ["Garden"] });
    expect(check(one, { text: "gard" })).toBe(true);
    expect(check(one, { text: "#gard" })).toBe(true);
    expect(check(one, { text: "#roof" })).toBe(false);
  });

  test("takes what Rust found in the description", () => {
    expect(check(task("1"), { text: "deep" }, new Set(["1"]))).toBe(true);
    expect(check(task("2"), { text: "deep" }, new Set(["1"]))).toBe(false);
  });

  test("ignores spaces around the text", () => {
    expect(check(task("1", { title: "Roof" }), { text: "  roof " })).toBe(true);
  });
});

describe("the other filters", () => {
  test("a task needs one of the chosen tags, in any case", () => {
    const one = task("1", { tags: ["Garden", "home"] });
    expect(check(one, { tags: ["garden", "work"] })).toBe(true);
    expect(check(one, { tags: ["work"] })).toBe(false);
    expect(check(one, { tags: ["HOME"] })).toBe(true);
  });

  test("a task needs one of the chosen priorities", () => {
    const one = task("1", { priority: "high" });
    expect(check(one, { priorities: ["high", "low"] })).toBe(true);
    expect(check(one, { priorities: ["low"] })).toBe(false);
    expect(check(task("2"), { priorities: ["none"] })).toBe(true);
  });

  test.each([
    ["overdue", "2026-11-10", true],
    ["overdue", DAY, false],
    ["overdue", null, false],
    ["today", DAY, true],
    ["today", "2026-11-12", false],
    ["today", null, false],
    ["week", DAY, true],
    ["week", "2026-11-15", true],
    ["week", "2026-11-16", false],
    ["week", "2026-11-10", false],
    ["week", null, false],
    ["none", null, true],
    ["none", DAY, false],
  ] as const)("due %s and a task due %s: %s", (choice, due, expected) => {
    expect(check(task("1", { due }), { due: [choice] })).toBe(expected);
  });

  test("the due choices add up", () => {
    const filter = { due: ["overdue", "none"] } as const;
    expect(check(task("1", { due: "2026-11-01" }), filter)).toBe(true);
    expect(check(task("2"), filter)).toBe(true);
    expect(check(task("3", { due: DAY }), filter)).toBe(false);
  });

  test("a task must fit every kind of filter", () => {
    const one = task("1", { title: "Roof", priority: "high", tags: ["home"] });
    expect(check(one, { text: "roof", priorities: ["high"] })).toBe(true);
    expect(check(one, { text: "roof", priorities: ["low"] })).toBe(false);
    expect(check(one, { text: "door", priorities: ["high"] })).toBe(false);
    expect(check(one, { tags: ["work"], priorities: ["high"] })).toBe(false);
  });
});

describe("endOfWeek", () => {
  test.each([
    ["2026-11-09", "2026-11-15"], // Monday
    ["2026-11-11", "2026-11-15"],
    ["2026-11-15", "2026-11-15"], // Sunday
    ["2026-12-30", "2027-01-03"], // Over the new year
  ])("%s ends on %s", (day, end) => {
    expect(endOfWeek(day)).toBe(end);
  });

  test("works from what today gives", () => {
    expect(endOfWeek(today(new Date(2026, 10, 11)))).toBe("2026-11-15");
  });
});

describe("filteredBoard", () => {
  const board: Board = {
    columns: [
      {
        id: "a",
        name: "A",
        tasks: [
          task("1", { title: "Roof" }),
          task("2", { title: "Door" }),
          task("3", { title: "Roof tiles" }),
        ],
      },
      { id: "b", name: "B", tasks: [task("4", { title: "Window" })] },
    ],
  };

  test("gives the very same board when nothing is filtered", () => {
    expect(filteredBoard(board, NO_FILTER, NOTHING, DAY)).toBe(board);
  });

  test("keeps the columns, also empty, and the order inside them", () => {
    const shown = filteredBoard(
      board,
      { ...NO_FILTER, text: "roof" },
      NOTHING,
      DAY,
    );
    expect(shown.columns.map((one) => one.tasks.map((t) => t.id))).toEqual([
      ["1", "3"],
      [],
    ]);
    expect(countTasks(shown)).toBe(2);
    expect(countTasks(board)).toBe(4);
  });

  test("leaves the board it was given alone", () => {
    filteredBoard(board, { ...NO_FILTER, text: "roof" }, NOTHING, DAY);
    expect(board.columns[0].tasks).toHaveLength(3);
  });
});

describe("tagChoices", () => {
  const board: Board = {
    columns: [
      {
        id: "a",
        name: "A",
        tasks: [task("1", { tags: ["zebra", "Apple"] })],
      },
      { id: "b", name: "B", tasks: [task("2", { tags: ["apple", "mango"] })] },
    ],
  };

  test("lists each tag once, sorted, in the first spelling", () => {
    expect(tagChoices(board, [])).toEqual(["Apple", "mango", "zebra"]);
  });

  test("keeps a chosen tag no task has any more, so it can be unticked", () => {
    expect(tagChoices(board, ["gone"])).toEqual([
      "Apple",
      "gone",
      "mango",
      "zebra",
    ]);
  });
});

describe("lastTaskIn", () => {
  test("is the bottom task, or nothing for an empty or unknown column", () => {
    const board: Board = { columns: [column("a", "1", "2"), column("b")] };
    expect(lastTaskIn(board, "a")?.id).toBe("2");
    expect(lastTaskIn(board, "b")).toBeUndefined();
    expect(lastTaskIn(board, "c")).toBeUndefined();
  });
});

describe("storedTarget", () => {
  // In a: 1, h, 2, k, 3 with h and k hidden. In b: 4, m, with m hidden. In c: only hidden.
  const board: Board = {
    columns: [
      column("a", "1", "h", "2", "k", "3"),
      column("b", "4", "m"),
      column("c", "n"),
    ],
  };
  const shown: Board = {
    columns: [column("a", "1", "2", "3"), column("b", "4"), column("c")],
  };
  const target = (columnId: string, index: number) =>
    storedTarget(board, shown, "2", { column: columnId, index });

  test("passes a move through when nothing is filtered", () => {
    const place = { column: "a", index: 1 };
    expect(storedTarget(board, board, "2", place)).toBe(place);
  });

  test("a card put back where it was changes nothing", () => {
    expect(target("a", 1)).toBeNull();
  });

  test("lands right before the card it is dropped on", () => {
    expect(target("a", 0)).toEqual({ column: "a", index: 0 });
    expect(target("b", 0)).toEqual({ column: "b", index: 0 });
  });

  test("lands right after the last one shown, before later hidden ones", () => {
    expect(target("a", 2)).toEqual({ column: "a", index: 4 });
    expect(target("b", 1)).toEqual({ column: "b", index: 1 });
  });

  test("goes to the bottom of a column showing nothing", () => {
    expect(target("c", 0)).toEqual({ column: "c", index: 1 });
  });

  test("gives up on a column that is gone", () => {
    expect(target("z", 0)).toBeNull();
  });
});

describe("what is remembered", () => {
  const filter = { ...NO_FILTER, text: "roof" };

  test("is kept for each project by itself", () => {
    rememberFilter("p", filter);
    expect(rememberedFilter("p")).toBe(filter);
    expect(rememberedFilter("q")).toBe(NO_FILTER);
  });

  test("an empty filter forgets the project", () => {
    rememberFilter("p", filter);
    rememberFilter("p", NO_FILTER);
    expect(rememberedFilter("p")).toBe(NO_FILTER);
  });
});
