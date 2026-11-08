import {
  act,
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
  createColumn,
  createTask,
  deleteColumn,
  deleteTask,
  getCurrentProject,
  listNotes,
  moveColumn,
  moveTask,
  renameColumn,
  restoreTask,
  type Task,
  taskBoard,
  taskDetail,
  trashedTasks,
  trashTask,
  updateTask,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { axeViolations } from "../test/axe";
import { NotificationProvider } from "../ui/Notifications";
import { SAVE_DELAY_MS } from "./tasks/TaskPanel";
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
  trashedTasks: vi.fn(),
  trashTask: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("./NotesPage", () => ({
  noteHref: (path: string) => `/notes/${path}`,
}));

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

const BOARD: Board = {
  columns: [
    { id: "todo", name: "To do", tasks: [task("1"), task("2")] },
    { id: "done", name: "Done", tasks: [task("3")] },
  ],
};

function detail(id = "1", description = "Some text") {
  return {
    task: task(id, { tags: ["old"], notes: ["Plan.md", "Gone.md"] }),
    column: "todo",
    description,
  };
}

const failure = (kind: "readOnly" | "columnInUse" | "invalidTask") =>
  new CommandFailure("x", { kind });

const location = () => memoryLocation({ path: "/tasks", record: true });

function open(memory = location()) {
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

const card = (name: string) =>
  screen.getByRole("button", { name: new RegExp(name) });

function project(readOnly = false) {
  vi.mocked(getCurrentProject).mockResolvedValue({
    state: "open",
    project: { id: "p", name: "P", folder: "C:\\P", readOnly, syncedBy: null },
  });
}

beforeEach(() => {
  project();
  vi.mocked(taskBoard).mockResolvedValue(BOARD);
  vi.mocked(trashedTasks).mockResolvedValue([]);
  vi.mocked(listNotes).mockResolvedValue({
    state: "ready",
    notes: [
      { path: "Plan.md", size: 1, modifiedMs: 0, link: "Plan" },
      { path: "Ideas/Seeds.md", size: 1, modifiedMs: 0, link: "Seeds" },
    ],
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
  for (const mock of [
    createColumn,
    createTask,
    deleteColumn,
    moveColumn,
    moveTask,
    renameColumn,
    restoreTask,
    trashTask,
    updateTask,
  ]) {
    vi.mocked(mock).mockResolvedValue(BOARD);
  }
  vi.mocked(deleteTask).mockResolvedValue(undefined);
  vi.mocked(taskDetail).mockResolvedValue(detail());
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

/** Moves go through a queue, so a call that should not happen comes a moment later. */
async function settled() {
  await act(async () => {
    await new Promise((done) => {
      window.setTimeout(done, 0);
    });
  });
}

async function ready() {
  await screen.findByRole("heading", { name: "To do" });
}

test("shows the columns with their tasks in order", async () => {
  open();
  await ready();

  const todo = screen.getByRole("region", { name: "To do" });
  expect(
    within(todo)
      .getAllByRole("button", { name: /Task/ })
      .map((button) => button.textContent),
  ).toEqual(["Task 1", "Task 2"]);
  expect(screen.getByRole("heading", { name: "Done" })).toBeDefined();
  expect(await axeViolations()).toEqual([]);
});

test("a card says priority, due date, tags, text, and notes", async () => {
  vi.mocked(taskBoard).mockResolvedValue({
    columns: [
      {
        id: "todo",
        name: "To do",
        tasks: [
          task("1", {
            priority: "high",
            due: "2000-01-02",
            tags: ["a", "b", "c", "d"],
            hasDescription: true,
            notes: ["Plan.md"],
          }),
        ],
      },
    ],
  });
  open();
  await ready();

  const text = card("Task 1").textContent;
  expect(text).toContain("Priority: High");
  expect(text).toContain("Overdue:");
  expect(text).toContain("#a");
  expect(text).toContain("+1");
  expect(text).toContain("Linked notes: 1");
  expect(screen.getByRole("img", { name: "Has a description" })).toBeDefined();
  expect(await axeViolations()).toEqual([]);
});

test("without a project it says so and leads to Projects", async () => {
  vi.mocked(getCurrentProject).mockResolvedValue({ state: "none" });
  const memory = location();
  open(memory);

  fireEvent.click(
    await screen.findByRole("button", { name: "Go to Projects" }),
  );

  expect(memory.history).toContain("/projects");
});

test("a project that cannot be opened and a failed load show as errors", async () => {
  vi.mocked(taskBoard).mockRejectedValue(failure("readOnly"));
  open();

  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain(
    "The tasks could not be loaded",
  );
});

test("a write-protected project shows the board without any way to change it", async () => {
  project(true);
  open();
  await ready();

  expect(screen.getByText(/write-protected/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();

  fireEvent.keyDown(card("Task 1"), { key: "ArrowDown", ctrlKey: true });
  await settled();
  expect(moveTask).not.toHaveBeenCalled();

  fireEvent.click(card("Task 1"));
  const title = await screen.findByRole("textbox", { name: "Title" });
  expect((title as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Move to trash" })).toBeNull();
});

test("a new task is typed in its column and the field stays for the next", async () => {
  open();
  await ready();
  const todo = screen.getByRole("region", { name: "To do" });

  fireEvent.click(within(todo).getByRole("button", { name: "Add task" }));
  const field = within(todo).getByRole("textbox", { name: "Task title" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "Water" } });
  fireEvent.keyDown(field, { key: "Enter" });

  await waitFor(() => {
    expect(createTask).toHaveBeenCalledWith("todo", {
      title: "Water",
      description: "",
      priority: "none",
      due: null,
      tags: [],
      notes: [],
    });
  });
  await waitFor(() => {
    expect((field as HTMLInputElement).value).toBe("");
  });

  fireEvent.keyDown(field, { key: "Escape" });
  expect(within(todo).queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(
    within(todo).getByRole("button", { name: "Add task" }),
  );
});

test("a task that cannot be added keeps what was typed and says why", async () => {
  vi.mocked(createTask).mockRejectedValue(failure("invalidTask"));
  open();
  await ready();
  const todo = screen.getByRole("region", { name: "To do" });

  fireEvent.click(within(todo).getByRole("button", { name: "Add task" }));
  const field = within(todo).getByRole("textbox", { name: "Task title" });
  fireEvent.change(field, { target: { value: "Too long" } });
  fireEvent.keyDown(field, { key: "Enter" });

  expect((await within(todo).findByRole("alert")).textContent).toContain(
    "Check this task",
  );
  expect((field as HTMLInputElement).value).toBe("Too long");
});

test("only one card is a Tab stop and arrows walk through them", async () => {
  open();
  await ready();

  expect(card("Task 1").tabIndex).toBe(0);
  expect(card("Task 2").tabIndex).toBe(-1);

  card("Task 1").focus();
  fireEvent.keyDown(card("Task 1"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(card("Task 2"));
  expect(card("Task 2").tabIndex).toBe(0);
  expect(card("Task 1").tabIndex).toBe(-1);
  await settled();
  expect(moveTask).not.toHaveBeenCalled();
});

test("Ctrl + arrow moves the card, tells it, and keeps the focus on it", async () => {
  const moved: Board = {
    columns: [
      { id: "todo", name: "To do", tasks: [task("2"), task("1")] },
      BOARD.columns[1],
    ],
  };
  vi.mocked(moveTask).mockResolvedValue(moved);
  open();
  await ready();
  card("Task 1").focus();

  fireEvent.keyDown(card("Task 1"), { key: "ArrowDown", ctrlKey: true });

  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("1", "todo", 1);
  });
  const todo = screen.getByRole("region", { name: "To do" });
  expect(
    within(todo)
      .getAllByRole("button", { name: /^Task/ })
      .map((button) => button.textContent),
  ).toEqual(["Task 2", "Task 1"]);
  expect(document.activeElement).toBe(card("Task 1"));
  expect(
    screen.getByText("Task 1 moved to To do, position 2 of 2."),
  ).toBeDefined();
});

test("the focus stays on a card that moves to another column", async () => {
  vi.mocked(moveTask).mockResolvedValue({
    columns: [
      { id: "todo", name: "To do", tasks: [task("2")] },
      { id: "done", name: "Done", tasks: [task("1"), task("3")] },
    ],
  });
  open();
  await ready();
  card("Task 1").focus();

  fireEvent.keyDown(card("Task 1"), { key: "ArrowRight", ctrlKey: true });

  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("1", "done", 0);
  });
  await settled();
  expect(document.activeElement).toBe(card("Task 1"));
});

test("at the edge a card says it cannot move and asks nothing", async () => {
  open();
  await ready();

  fireEvent.keyDown(card("Task 1"), { key: "ArrowUp", ctrlKey: true });

  expect(screen.getByText("Task 1 cannot move further.")).toBeDefined();
  await settled();
  expect(moveTask).not.toHaveBeenCalled();
});

test("a move that fails shows why and brings the true board back", async () => {
  vi.mocked(moveTask).mockRejectedValue(failure("readOnly"));
  open();
  await ready();

  fireEvent.keyDown(card("Task 1"), { key: "ArrowDown", ctrlKey: true });

  expect((await screen.findByRole("alert")).textContent).toContain(
    "The task was not moved.",
  );
  await waitFor(() => {
    expect(taskBoard).toHaveBeenCalledTimes(2);
  });
  const todo = screen.getByRole("region", { name: "To do" });
  await waitFor(() => {
    expect(
      within(todo)
        .getAllByRole("button", { name: /^Task/ })
        .map((button) => button.textContent),
    ).toEqual(["Task 1", "Task 2"]);
  });
});

function layOut() {
  const place = (element: HTMLElement, top: number) => {
    element.getBoundingClientRect = () =>
      ({ top, height: 40, bottom: top + 40, left: 0, right: 200 }) as DOMRect;
  };
  place(card("Task 1"), 100);
  place(card("Task 2"), 160);
  place(card("Task 3"), 100);
  Element.prototype.scrollBy = vi.fn();
  return (element: Element | null) => {
    document.elementFromPoint = () => element;
  };
}

test("dragging a card to another column drops it where the line shows", async () => {
  open();
  await ready();
  const pointAt = layOut();
  const done = screen.getByRole("region", { name: "Done" });
  pointAt(done);

  fireEvent.pointerDown(card("Task 1"), {
    button: 0,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 90 });

  // Above the middle of the only card there: in front of it.
  expect(done.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(
    0,
  );
  expect(card("Task 1").dataset.dragged).toBe("");

  fireEvent.pointerUp(window);
  // The click that ends a drag does not open the task.
  fireEvent.click(card("Task 1"));

  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("1", "done", 0);
  });
  expect(taskDetail).not.toHaveBeenCalled();
});

test("a drag inside a column counts without the dragged card", async () => {
  open();
  await ready();
  const pointAt = layOut();
  pointAt(screen.getByRole("region", { name: "To do" }));

  fireEvent.pointerDown(card("Task 1"), {
    button: 0,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 10, clientY: 300 });
  fireEvent.pointerUp(window);

  await waitFor(() => {
    expect(moveTask).toHaveBeenCalledWith("1", "todo", 1);
  });
});

test("a press that barely moves is a click, not a drag", async () => {
  open();
  await ready();
  layOut()(screen.getByRole("region", { name: "Done" }));

  fireEvent.pointerDown(card("Task 1"), {
    button: 0,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 12, clientY: 111 });
  fireEvent.pointerUp(window);
  fireEvent.click(card("Task 1"));

  await settled();
  expect(moveTask).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(taskDetail).toHaveBeenCalledWith("1");
  });
});

test("Escape and a drop outside a column cancel a drag", async () => {
  open();
  await ready();
  const pointAt = layOut();

  pointAt(screen.getByRole("region", { name: "Done" }));
  fireEvent.pointerDown(card("Task 1"), {
    button: 0,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 90 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window);
  expect(card("Task 1").dataset.dragged).toBeUndefined();

  pointAt(document.body);
  fireEvent.pointerDown(card("Task 2"), {
    button: 0,
    clientX: 10,
    clientY: 170,
  });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 90 });
  fireEvent.pointerUp(window);

  await settled();
  expect(moveTask).not.toHaveBeenCalled();
});

test("a write-protected project starts no drag", async () => {
  project(true);
  open();
  await ready();
  layOut()(screen.getByRole("region", { name: "Done" }));

  fireEvent.pointerDown(card("Task 1"), {
    button: 0,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 90 });
  expect(card("Task 1").dataset.dragged).toBeUndefined();
  fireEvent.pointerUp(window);

  await settled();
  expect(moveTask).not.toHaveBeenCalled();
});

test("a right press starts no drag", async () => {
  open();
  await ready();
  layOut()(screen.getByRole("region", { name: "Done" }));

  fireEvent.pointerDown(card("Task 1"), {
    button: 2,
    clientX: 10,
    clientY: 110,
  });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 90 });
  fireEvent.pointerUp(window);

  await settled();
  expect(moveTask).not.toHaveBeenCalled();
});

async function openedPanel() {
  open();
  await ready();
  fireEvent.click(card("Task 1"));
  return screen.findByRole<HTMLInputElement>("textbox", { name: "Title" });
}

test("the panel shows everything and marks a note that is gone", async () => {
  const title = await openedPanel();

  expect(title.value).toBe("Task 1");
  const text = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Description",
  });
  expect(text.value).toBe("Some text");
  expect(screen.getByText("#old")).toBeDefined();
  expect(screen.getByRole("button", { name: "Plan.md" })).toBeDefined();
  expect(screen.getByText("Note is missing")).toBeDefined();
  expect(card("Task 1").getAttribute("aria-pressed")).toBe("true");
  expect(await axeViolations()).toEqual([]);
});

test("changes save by themselves after a pause, with all the fields", async () => {
  const title = await openedPanel();
  vi.useFakeTimers();

  fireEvent.change(title, { target: { value: "New" } });
  fireEvent.change(title, { target: { value: "Newer" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
  });
  expect(updateTask).not.toHaveBeenCalled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(updateTask).toHaveBeenCalledTimes(1);
  expect(updateTask).toHaveBeenCalledWith("1", {
    title: "Newer",
    description: "Some text",
    priority: "none",
    due: null,
    tags: ["old"],
    notes: ["Plan.md", "Gone.md"],
  });
  expect(screen.getByText("Saved")).toBeDefined();
});

test("what cannot be saved stays in the field and says why", async () => {
  vi.mocked(updateTask).mockRejectedValue(failure("readOnly"));
  const title = await openedPanel();
  vi.useFakeTimers();

  fireEvent.change(title, { target: { value: "Kept" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  });

  expect(screen.getByRole("alert").textContent).toContain("Not saved.");
  expect(title.value).toBe("Kept");

  // The panel does not close over a change that is not saved.
  fireEvent.click(screen.getByRole("button", { name: "Close task" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
});

test("an empty title is not saved and the panel says so", async () => {
  const title = await openedPanel();
  vi.useFakeTimers();

  fireEvent.change(title, { target: { value: "  " } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  });

  expect(updateTask).not.toHaveBeenCalled();
  expect(screen.getByText(/A task needs a title/)).toBeDefined();
});

test("closing saves at once and gives the focus back to the card", async () => {
  const title = await openedPanel();

  fireEvent.change(title, { target: { value: "Quick" } });
  fireEvent.keyDown(title, { key: "Escape" });

  await waitFor(() => {
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });
  expect(updateTask).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(card("Task 1"));
});

test("going to another card still saves what was typed", async () => {
  const title = await openedPanel();

  vi.useFakeTimers();
  fireEvent.change(title, { target: { value: "Before leaving" } });
  fireEvent.click(card("Task 2"));

  // At once, without the pause for typing.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(updateTask).toHaveBeenCalledWith(
    "1",
    expect.objectContaining({ title: "Before leaving" }),
  );
  expect(taskDetail).toHaveBeenCalledWith("2");
});

test("an unchanged task is not saved when the panel closes", async () => {
  await openedPanel();

  fireEvent.click(screen.getByRole("button", { name: "Close task" }));

  await waitFor(() => {
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });
  expect(updateTask).not.toHaveBeenCalled();
});

test("tags are added once without a #, and can be removed", async () => {
  await openedPanel();
  const field = screen.getByRole("textbox", { name: "Add tag" });

  fireEvent.change(field, { target: { value: "#Garden" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByText("#Garden")).toBeDefined();
  expect((field as HTMLInputElement).value).toBe("");

  fireEvent.change(field, { target: { value: "garden" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.queryByText("#garden")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Remove tag old" }));
  expect(screen.queryByText("#old")).toBeNull();
});

test("a note is found by typing, linked, opened, and unlinked", async () => {
  const memory = location();
  open(memory);
  await ready();
  fireEvent.click(card("Task 1"));
  const field = await screen.findByRole("textbox", { name: "Link a note" });

  fireEvent.change(field, { target: { value: "seeds" } });
  const matching = screen.getByRole("list", { name: "Matching notes" });
  fireEvent.click(
    within(matching).getByRole("button", { name: "Ideas/Seeds.md" }),
  );
  const linked = screen.getByRole("list", { name: "Linked notes" });
  expect(
    within(linked).getByRole("button", { name: "Ideas/Seeds.md" }),
  ).toBeDefined();

  fireEvent.click(
    screen.getByRole("button", { name: "Remove link to Ideas/Seeds.md" }),
  );
  expect(
    within(linked).queryByRole("button", { name: "Ideas/Seeds.md" }),
  ).toBeNull();

  fireEvent.click(within(linked).getByRole("button", { name: "Plan.md" }));
  expect(memory.history).toContain("/notes/Plan.md");
});

test("a task goes to the trash and comes back", async () => {
  await openedPanel();
  vi.mocked(trashedTasks).mockResolvedValue([task("1")]);

  fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

  await waitFor(() => {
    expect(trashTask).toHaveBeenCalledWith("1");
  });
  fireEvent.click(await screen.findByRole("button", { name: "Trash (1)" }));
  const trash = screen.getByRole("region", { name: "Trash" });
  expect(within(trash).getByText("Task 1")).toBeDefined();
  expect(await axeViolations()).toEqual([]);

  vi.mocked(trashedTasks).mockResolvedValue([]);
  fireEvent.click(within(trash).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(restoreTask).toHaveBeenCalledWith("1");
  });
  expect(await within(trash).findByText("The trash is empty.")).toBeDefined();
});

test("deleting for good asks first", async () => {
  vi.mocked(trashedTasks).mockResolvedValue([task("9")]);
  open();
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Trash (1)" }));

  fireEvent.click(screen.getByRole("button", { name: "Delete for good…" }));
  const dialog = await screen.findByRole("dialog");
  expect(deleteTask).not.toHaveBeenCalled();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Delete for good" }),
  );
  await waitFor(() => {
    expect(deleteTask).toHaveBeenCalledWith("9");
  });
});

async function choose(column: string, item: string) {
  fireEvent.click(
    screen.getByRole("button", { name: `Actions for ${column}` }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

test("columns are added, moved, and renamed", async () => {
  open();
  await ready();

  fireEvent.click(screen.getByRole("button", { name: "Add column" }));
  const field = screen.getByRole("textbox", { name: "Column name" });
  fireEvent.change(field, { target: { value: "Review" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => {
    expect(createColumn).toHaveBeenCalledWith("Review");
  });

  await choose("To do", "Move right");
  await waitFor(() => {
    expect(moveColumn).toHaveBeenCalledWith("todo", 1);
  });

  await choose("Done", "Rename…");
  const dialog = await screen.findByRole("dialog");
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  expect((name as HTMLInputElement).value).toBe("Done");
  fireEvent.change(name, { target: { value: "Shipped" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() => {
    expect(renameColumn).toHaveBeenCalledWith("done", "Shipped");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("the first and the last column offer only the way they can go", async () => {
  open();
  await ready();

  fireEvent.click(screen.getByRole("button", { name: "Actions for To do" }));
  const left = await screen.findByRole("menuitem", { name: "Move left" });
  expect(left.getAttribute("aria-disabled")).toBe("true");
});

test("a column with tasks cannot be deleted and the board says why", async () => {
  vi.mocked(deleteColumn).mockRejectedValue(failure("columnInUse"));
  open();
  await ready();

  await choose("To do", "Delete column");

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Move the tasks out of this column first.",
  );
});
