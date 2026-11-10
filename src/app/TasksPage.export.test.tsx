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
  exportTasks,
  exportTasksElsewhere,
  getCurrentProject,
  listNotes,
  moveTask,
  type Task,
  taskBoard,
  trashedTasks,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { axeViolations } from "../test/axe";
import { NotificationProvider } from "../ui/Notifications";
import { forgetFilters } from "./tasks/filter";
import { TasksPage } from "./TasksPage";

vi.mock("../lib/ipc/commands", () => ({
  createColumn: vi.fn(),
  createTask: vi.fn(),
  deleteColumn: vi.fn(),
  deleteTask: vi.fn(),
  exportTasks: vi.fn(),
  exportTasksElsewhere: vi.fn(),
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

function task(id: string): Task {
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
  };
}

const BOARD: Board = {
  columns: [{ id: "todo", name: "To do", tasks: [task("1"), task("2")] }],
};

function project(readOnly = false) {
  vi.mocked(getCurrentProject).mockResolvedValue({
    state: "open",
    project: { id: "p", name: "P", folder: "C:\\P", readOnly, syncedBy: null },
  });
}

const failure = (kind: "invalidPath" | "readOnly") =>
  new CommandFailure("x", { kind });

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

beforeEach(() => {
  forgetFilters();
  project();
  vi.mocked(taskBoard).mockResolvedValue(BOARD);
  vi.mocked(trashedTasks).mockResolvedValue([]);
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
  vi.mocked(exportTasks).mockResolvedValue({
    state: "written",
    place: "Tasks export.md",
  });
  vi.mocked(exportTasksElsewhere).mockResolvedValue({ state: "cancelled" });
});

afterEach(() => {
  vi.resetAllMocks();
});

/** By its name: a notification has the role of a dialog too. */
const exportDialog = () =>
  screen.queryByRole("dialog", { name: /^(Export tasks|Replace)/ });

async function dialog() {
  await screen.findByRole("heading", { name: "To do" });
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  return within(await screen.findByRole("dialog"));
}

async function settled() {
  await act(async () => {
    await new Promise((done) => {
      window.setTimeout(done, 0);
    });
  });
}

test("the dialog says what will happen and where", async () => {
  open();
  const inside = await dialog();

  expect(inside.getByRole("heading", { name: "Export tasks" })).toBeDefined();
  expect(screen.getByRole("dialog").textContent).toContain("without the trash");
  expect(screen.getByRole("dialog").textContent).toContain(
    "In the project: Tasks export.md",
  );
  expect(await axeViolations()).toEqual([]);
  expect(exportTasks).not.toHaveBeenCalled();
});

test("saving in the project closes the dialog and says where it went", async () => {
  open();
  const inside = await dialog();

  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));

  await waitFor(() => {
    expect(exportDialog()).toBeNull();
  });
  expect(exportTasks).toHaveBeenCalledWith(false);
  expect(await screen.findByText("Tasks exported")).toBeDefined();
  expect(screen.getByText("Tasks export.md")).toBeDefined();
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Export…" }),
    );
  });
});

test("a different file is replaced only on the owner's word", async () => {
  vi.mocked(exportTasks).mockResolvedValueOnce({ state: "exists" });
  open();
  const inside = await dialog();
  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));

  const replace = await inside.findByRole("button", { name: "Replace" });
  expect(screen.getByRole("dialog").textContent).toContain("project's trash");
  expect(exportTasks).toHaveBeenCalledTimes(1);
  expect(exportTasks).toHaveBeenLastCalledWith(false);
  expect(await axeViolations()).toEqual([]);

  fireEvent.click(replace);

  await waitFor(() => {
    expect(exportDialog()).toBeNull();
  });
  expect(exportTasks).toHaveBeenCalledTimes(2);
  expect(exportTasks).toHaveBeenLastCalledWith(true);
});

test("Keep it writes nothing more", async () => {
  vi.mocked(exportTasks).mockResolvedValueOnce({ state: "exists" });
  open();
  const inside = await dialog();
  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));

  fireEvent.click(await inside.findByRole("button", { name: "Keep it" }));

  await waitFor(() => {
    expect(exportDialog()).toBeNull();
  });
  expect(exportTasks).toHaveBeenCalledTimes(1);
});

test("another place asks Rust, which shows the Windows dialog", async () => {
  vi.mocked(exportTasksElsewhere).mockResolvedValue({
    state: "written",
    place: "D:\\Backup\\Tasks.md",
  });
  open();
  const inside = await dialog();

  fireEvent.click(inside.getByRole("button", { name: "Other place…" }));

  expect(await screen.findByText("D:\\Backup\\Tasks.md")).toBeDefined();
  expect(exportTasks).not.toHaveBeenCalled();
  expect(exportDialog()).toBeNull();
});

test("closing the Windows dialog leaves this one open and says nothing", async () => {
  open();
  const inside = await dialog();

  fireEvent.click(inside.getByRole("button", { name: "Other place…" }));
  await waitFor(() => {
    expect(exportTasksElsewhere).toHaveBeenCalled();
  });
  await settled();

  expect(screen.getByRole("dialog")).toBeDefined();
  expect(screen.queryByText("Tasks exported")).toBeNull();
  expect(
    inside.getByRole<HTMLButtonElement>("button", { name: "Save in project" })
      .disabled,
  ).toBe(false);
});

test("a failure stays in the dialog, says why, and can be tried again", async () => {
  vi.mocked(exportTasks).mockRejectedValueOnce(failure("readOnly"));
  open();
  const inside = await dialog();

  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));

  expect((await inside.findByRole("alert")).textContent).toContain(
    "write-protected",
  );
  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));
  await waitFor(() => {
    expect(exportDialog()).toBeNull();
  });
});

test("a chosen name that is no Markdown file is explained", async () => {
  vi.mocked(exportTasksElsewhere).mockRejectedValue(failure("invalidPath"));
  open();
  const inside = await dialog();

  fireEvent.click(inside.getByRole("button", { name: "Other place…" }));

  expect((await inside.findByRole("alert")).textContent).toContain(".md");
});

test("a write-protected project can only export elsewhere", async () => {
  project(true);
  open();
  const inside = await dialog();

  expect(inside.queryByRole("button", { name: "Save in project" })).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("write-protected");

  fireEvent.click(inside.getByRole("button", { name: "Choose a place…" }));

  await waitFor(() => {
    expect(exportTasksElsewhere).toHaveBeenCalled();
  });
});

test("a second click while one runs asks only once", async () => {
  vi.mocked(exportTasks).mockReturnValue(new Promise(() => undefined));
  open();
  const inside = await dialog();
  const save = inside.getByRole("button", { name: "Save in project" });

  fireEvent.click(save);
  await settled();
  fireEvent.click(save);
  fireEvent.click(inside.getByRole("button", { name: "Other place…" }));
  await settled();

  expect(exportTasks).toHaveBeenCalledTimes(1);
  expect(exportTasksElsewhere).not.toHaveBeenCalled();
});

test("the file holds a move asked for before it", async () => {
  let finishMove: (board: Board) => void = () => undefined;
  vi.mocked(moveTask).mockReturnValue(
    new Promise((resolve) => {
      finishMove = resolve;
    }),
  );
  open();
  await screen.findByRole("heading", { name: "To do" });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Task 1/ }), {
    key: "ArrowDown",
    ctrlKey: true,
  });
  await settled();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  const inside = within(await screen.findByRole("dialog"));

  fireEvent.click(inside.getByRole("button", { name: "Save in project" }));
  await settled();
  expect(exportTasks).not.toHaveBeenCalled();

  await act(async () => {
    finishMove(BOARD);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(exportTasks).toHaveBeenCalledWith(false);
  });
});
