import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { Router } from "wouter";
import {
  type Board,
  createTask,
  getCurrentProject,
  listNotes,
  moveTask,
  type Task,
  taskBoard,
  taskDetail,
  tasksWithDescription,
  trashedTasks,
  trashTask,
  updateTask,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { axeViolations } from "../test/axe";
import { NotificationProvider } from "../ui/Notifications";
import { forgetFilters } from "./tasks/filter";
import { SEARCH_DELAY_MS } from "./tasks/useDescriptionSearch";
import { TasksPage } from "./TasksPage";

vi.mock("../lib/ipc/commands", () => ({
  createColumn: vi.fn(),
  createTask: vi.fn(),
  deleteColumn: vi.fn(),
  deleteTask: vi.fn(),
  getCurrentProject: vi.fn(),
  listNotes: vi.fn(),
  moveColumn: vi.fn(),
  moveTask: vi.fn(),
  renameColumn: vi.fn(),
  restoreTask: vi.fn(),
  taskBoard: vi.fn(),
  taskDetail: vi.fn(),
  tasksWithDescription: vi.fn(),
  trashedTasks: vi.fn(),
  trashTask: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("./NotesPage", () => ({
  noteHref: (path: string) => `/notes/${path}`,
}));

function task(id: string, title: string, more: Partial<Task> = {}): Task {
  return {
    id,
    title,
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

// Door and Shed sit between the roofs, so a move while filtered has hidden tasks to mind.
const BOARD: Board = {
  columns: [
    {
      id: "todo",
      name: "To do",
      tasks: [
        task("1", "Roof one", { tags: ["home"], priority: "high" }),
        task("2", "Door", { tags: ["work"] }),
        task("3", "Roof two", { priority: "low", due: "2000-01-02" }),
        task("4", "Shed"),
        task("5", "Roof three"),
      ],
    },
    { id: "done", name: "Done", tasks: [task("6", "Window")] },
  ],
};

const failure = () => new CommandFailure("x", { kind: "internal" });

function open() {
  const memory = memoryLocation({ path: "/tasks", record: true });
  return render(
    <NotificationProvider>
      <Router hook={memory.hook}>
        <main>
          <TasksPage />
        </main>
      </Router>
    </NotificationProvider>,
  );
}

function project(id = "p") {
  vi.mocked(getCurrentProject).mockResolvedValue({
    state: "open",
    project: {
      id,
      name: "P",
      folder: "C:\\P",
      readOnly: false,
      syncedBy: null,
    },
  });
}

beforeEach(() => {
  forgetFilters();
  project();
  vi.mocked(taskBoard).mockResolvedValue(BOARD);
  vi.mocked(trashedTasks).mockResolvedValue([]);
  vi.mocked(tasksWithDescription).mockResolvedValue([]);
  vi.mocked(listNotes).mockResolvedValue({
    state: "ready",
    notes: [],
    skipped: {
      linksOutside: 0,
      brokenLinks: 0,
      badNames: 0,
      unreadable: 0,
      tooDeep: 0,
      depthLimit: 64,
    },
    truncated: false,
    noteLimit: 100000,
    emptyFolders: [],
  });
  vi.mocked(moveTask).mockResolvedValue(BOARD);
  vi.mocked(createTask).mockResolvedValue(BOARD);
  vi.mocked(trashTask).mockResolvedValue(BOARD);
  vi.mocked(updateTask).mockResolvedValue(BOARD);
  vi.mocked(taskDetail).mockResolvedValue({
    task: BOARD.columns[0].tasks[0],
    column: "todo",
    description: "",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function ready() {
  await screen.findByRole("heading", { name: "To do" });
}

const field = () =>
  screen.getByRole<HTMLInputElement>("searchbox", { name: "Filter by text" });

const type = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};

/** The titles shown in a column, top first. */
function shownIn(name: string): string[] {
  return within(screen.getByRole("region", { name }))
    .queryAllByRole("listitem")
    .map(
      (item) =>
        item.querySelector("[data-task] span")?.textContent ?? "(no title)",
    );
}

const card = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

const status = () =>
  within(screen.getByRole("search", { name: "Filter tasks" })).getByRole(
    "status",
  ).textContent;

async function tick(text: string, menu: string) {
  fireEvent.click(screen.getByRole("button", { name: menu }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: text }));
}

/** Long enough for the search to have been asked, and answered. */
async function searched() {
  await act(async () => {
    await new Promise((done) => {
      window.setTimeout(done, SEARCH_DELAY_MS + 20);
    });
  });
}

function layOut() {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-task]")];
  const perColumn = new Map<Element | null, number>();
  for (const one of cards) {
    const column = one.closest("[data-column]");
    const place = perColumn.get(column) ?? 0;
    perColumn.set(column, place + 1);
    const top = 100 + place * 60;
    one.getBoundingClientRect = () =>
      ({ top, height: 40, bottom: top + 40 }) as DOMRect;
  }
  Element.prototype.scrollBy = vi.fn();
  return (element: Element) => {
    document.elementFromPoint = () => element;
  };
}

test("typing keeps the matching cards and says how many of how many", async () => {
  open();
  await ready();
  expect(status()).toBe("");

  type("ROOF");

  expect(shownIn("To do")).toEqual(["Roof one", "Roof two", "Roof three"]);
  expect(status()).toBe("3 of 6 tasks");
  expect(screen.getByRole("region", { name: "To do" }).textContent).toContain(
    "3 of 5",
  );
  expect(screen.getByRole("region", { name: "Done" }).textContent).toContain(
    "0 of 1",
  );
  expect(await axeViolations()).toEqual([]);
});

test("Clear filters brings every card back and takes itself away", async () => {
  open();
  await ready();
  type("roof");
  await tick("High", "Priority");
  expect(shownIn("To do")).toEqual(["Roof one"]);

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  await waitFor(() => {
    expect(shownIn("To do")).toHaveLength(5);
  });
  expect(field().value).toBe("");
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  expect(screen.getByRole("button", { name: "Priority" })).toBeDefined();
});

test("Escape empties the text and only the text", async () => {
  open();
  await ready();
  await tick("High", "Priority");
  type("roof");

  fireEvent.keyDown(field(), { key: "Escape" });

  expect(field().value).toBe("");
  expect(screen.getByRole("button", { name: "Priority (1)" })).toBeDefined();
});

test("no task fitting says so", async () => {
  open();
  await ready();

  type("nothing like this");

  expect(status()).toBe("No task fits these filters.");
  expect(screen.getByRole("region", { name: "To do" })).toBeDefined();
});

test("a word only in a description comes from Rust, once for what was typed", async () => {
  vi.mocked(tasksWithDescription).mockResolvedValue(["4"]);
  open();
  await ready();

  type("d");
  type("de");
  type(" deep ");
  await searched();

  expect(shownIn("To do")).toEqual(["Shed"]);
  expect(tasksWithDescription).toHaveBeenCalledTimes(1);
  expect(tasksWithDescription).toHaveBeenCalledWith("deep");
});

test("without text Rust is not asked", async () => {
  open();
  await ready();

  await tick("High", "Priority");
  await searched();

  expect(tasksWithDescription).not.toHaveBeenCalled();
});

test("an answer for text typed earlier is dropped", async () => {
  let answerFirst: (ids: string[]) => void = () => undefined;
  vi.mocked(tasksWithDescription).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
  );
  vi.mocked(tasksWithDescription).mockResolvedValue(["6"]);
  open();
  await ready();

  type("old");
  await searched();
  type("new");
  await searched();
  expect(shownIn("Done")).toEqual(["Window"]);

  await act(async () => {
    answerFirst(["4"]);
    await Promise.resolve();
  });

  expect(shownIn("Done")).toEqual(["Window"]);
  expect(shownIn("To do")).toEqual([]);
});

test("what was found for earlier text does not count for new text", async () => {
  vi.mocked(tasksWithDescription).mockResolvedValue(["4"]);
  open();
  await ready();
  type("deep");
  await searched();
  expect(shownIn("To do")).toEqual(["Shed"]);

  type("deeper");

  expect(shownIn("To do")).toEqual([]);
});

test("a failed search says so and titles still filter", async () => {
  vi.mocked(tasksWithDescription).mockRejectedValue(failure());
  open();
  await ready();

  type("roof");

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Descriptions could not be searched",
  );
  expect(shownIn("To do")).toHaveLength(3);
});

test("what the board changes asks for descriptions again", async () => {
  open();
  await ready();
  type("deep");
  await searched();
  expect(tasksWithDescription).toHaveBeenCalledTimes(1);

  vi.mocked(tasksWithDescription).mockResolvedValue(["6"]);
  // A description can have changed with any answer that brings a new board.
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  type("deep");
  await searched();

  expect(shownIn("Done")).toEqual(["Window"]);
});

test("a move asks for descriptions again, as the board is a new one", async () => {
  vi.mocked(tasksWithDescription).mockResolvedValue(["1", "3"]);
  open();
  await ready();
  type("deep");
  await searched();
  expect(tasksWithDescription).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(card("Roof one"), { key: "ArrowDown", ctrlKey: true });
  await searched();

  expect(tasksWithDescription).toHaveBeenCalledTimes(2);
});

test("a tag menu stays open, ticks up, and filters by any of them", async () => {
  open();
  await ready();

  await tick("#home", "Tags");
  const second = await screen.findByRole("menuitemcheckbox", { name: "#work" });
  expect(
    screen
      .getByRole("menuitemcheckbox", { name: "#home" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(await axeViolations()).toEqual([]);

  fireEvent.click(second);

  await waitFor(() => {
    expect(shownIn("To do")).toEqual(["Roof one", "Door"]);
  });
  expect(screen.getByRole("button", { name: "Tags (2)" })).toBeDefined();
});

test("a board without tags says so in the menu", async () => {
  vi.mocked(taskBoard).mockResolvedValue({
    columns: [{ id: "todo", name: "To do", tasks: [task("1", "A")] }],
  });
  open();
  await ready();

  fireEvent.click(screen.getByRole("button", { name: "Tags" }));

  const item = await screen.findByRole("menuitem", { name: "No tags yet" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
});

test("priority and due date filter together", async () => {
  open();
  await ready();

  await tick("Low", "Priority");
  expect(shownIn("To do")).toEqual(["Roof two"]);

  await tick("No date", "Due");

  await waitFor(() => {
    expect(status()).toBe("No task fits these filters.");
  });
  expect(screen.getByRole("button", { name: "Due (1)" })).toBeDefined();
});

test("filtering writes nothing", async () => {
  open();
  await ready();

  type("roof");
  await tick("High", "Priority");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await searched();

  expect(moveTask).not.toHaveBeenCalled();
  expect(updateTask).not.toHaveBeenCalled();
  expect(createTask).not.toHaveBeenCalled();
});

test("Ctrl + an arrow steps over the hidden tasks", async () => {
  open();
  await ready();
  type("roof");

  fireEvent.keyDown(card("Roof two"), { key: "ArrowDown", ctrlKey: true });

  // Whole column without it: Roof one, Door, Shed, Roof three. After Roof three.
  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("3", "todo", 4);
  });
});

test("a drag while filtered lands before the card it is dropped on", async () => {
  open();
  await ready();
  type("roof");
  const pointAt = layOut();
  pointAt(screen.getByRole("region", { name: "To do" }));

  fireEvent.pointerDown(card("Roof three"), {
    button: 0,
    clientX: 10,
    clientY: 230,
  });
  fireEvent.pointerMove(window, { clientX: 12, clientY: 150 });
  fireEvent.pointerUp(window);

  // Before Roof two, which comes after Door in the whole column.
  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("5", "todo", 2);
  });
});

test("a card dragged back to its place while filtered is not moved", async () => {
  open();
  await ready();
  type("roof");
  const pointAt = layOut();
  pointAt(screen.getByRole("region", { name: "To do" }));

  fireEvent.pointerDown(card("Roof two"), {
    button: 0,
    clientX: 10,
    clientY: 170,
  });
  // Roof one's middle is 120 and Roof three's 220: still between them.
  fireEvent.pointerMove(window, { clientX: 12, clientY: 180 });
  fireEvent.pointerUp(window);
  await searched();

  expect(moveTask).not.toHaveBeenCalled();
});

test("a filter stays when the page is left and comes back", async () => {
  open();
  await ready();
  type("roof");

  cleanup();
  open();
  await ready();

  expect(field().value).toBe("roof");
  expect(shownIn("To do")).toHaveLength(3);
});

test("each project has its own filter", async () => {
  open();
  await ready();
  type("roof");

  cleanup();
  project("other");
  open();
  await ready();

  expect(field().value).toBe("");
  expect(shownIn("To do")).toHaveLength(5);
});

test("a new task the filters hide says so, a new filter ends that", async () => {
  vi.mocked(createTask).mockResolvedValue({
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [...BOARD.columns[0].tasks, task("7", "Fence")],
      },
      BOARD.columns[1],
    ],
  });
  open();
  await ready();
  type("roof");
  const todo = screen.getByRole("region", { name: "To do" });

  fireEvent.click(within(todo).getByRole("button", { name: "Add task" }));
  const title = within(todo).getByRole("textbox", { name: "Task title" });
  fireEvent.change(title, { target: { value: "Fence" } });
  fireEvent.keyDown(title, { key: "Enter" });

  await waitFor(() => {
    expect(status()).toContain("The new task is hidden by the filters.");
  });

  type("roofs");

  expect(status()).not.toContain("hidden");
});

test("a new task that fits the filters shows without a word", async () => {
  vi.mocked(createTask).mockResolvedValue({
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [...BOARD.columns[0].tasks, task("7", "Roof four")],
      },
      BOARD.columns[1],
    ],
  });
  open();
  await ready();
  type("roof");
  const todo = screen.getByRole("region", { name: "To do" });

  fireEvent.click(within(todo).getByRole("button", { name: "Add task" }));
  const title = within(todo).getByRole("textbox", { name: "Task title" });
  fireEvent.change(title, { target: { value: "Roof four" } });
  fireEvent.keyDown(title, { key: "Enter" });

  await waitFor(() => {
    expect(shownIn("To do")).toContain("Roof four");
  });
  expect(status()).toBe("4 of 7 tasks");
});

test("closing a task the filter hid leads back to the filter", async () => {
  open();
  await ready();
  fireEvent.click(card("Door"));
  await screen.findByRole("textbox", { name: "Title" });
  type("roof");

  fireEvent.click(screen.getByRole("button", { name: "Close task" }));

  await waitFor(() => {
    expect(document.activeElement).toBe(field());
  });
});

test("closing a task still shown goes back to its card", async () => {
  open();
  await ready();
  fireEvent.click(card("Roof one"));
  await screen.findByRole("textbox", { name: "Title" });
  type("roof");

  fireEvent.click(screen.getByRole("button", { name: "Close task" }));

  await waitFor(() => {
    expect(document.activeElement).toBe(card("Roof one"));
  });
});
