import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  createFolder,
  createNote,
  moveEntry,
  renameEntry,
  trashEntry,
} from "../../lib/ipc/commands";
import { CommandFailure } from "../../lib/ipc/errors";
import { NoteTree } from "./NoteTree";
import {
  allFolders,
  ancestors,
  buildTree,
  canMoveInto,
  isInside,
  visibleRows,
} from "./tree";

vi.mock("../../lib/ipc/commands", () => ({
  createNote: vi.fn(),
  createFolder: vi.fn(),
  renameEntry: vi.fn(),
  moveEntry: vi.fn(),
  trashEntry: vi.fn(),
}));

const note = (path: string) => ({ path, size: 1, modifiedMs: 0, link: path });

const TOP = buildTree(
  [note("README.md"), note("Ideas/Plan.md"), note("Ideas/Deep/x.md")],
  ["Empty"],
);

function renderTree(
  openPath: string | null = null,
  only: { key: string; notes: ReadonlySet<string> } | null = null,
) {
  const onChanged = vi.fn();
  const { hook, history } = memoryLocation({ path: "/notes", record: true });
  const { container } = render(
    <Router hook={hook}>
      <NoteTree
        top={TOP}
        only={only}
        openPath={openPath}
        noteHref={(path) => `/notes/${path}`}
        onChanged={onChanged}
      />
    </Router>,
  );
  return { onChanged, history, container };
}

function tree() {
  return screen.getByRole("navigation", { name: "Notes in this project" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("the tree puts folders first, sorts by name, and keeps empty folders", () => {
  const rows = visibleRows(TOP, new Set(["Ideas"]));
  expect(rows.map((row) => `${String(row.level)} ${row.node.path}`)).toEqual([
    "1 Empty",
    "1 Ideas",
    "2 Ideas/Deep",
    "2 Ideas/Plan.md",
    "1 README.md",
  ]);
  expect(allFolders(TOP)).toEqual(["", "Empty", "Ideas", "Ideas/Deep"]);
  expect(ancestors("a/b/c.md")).toEqual(["a", "a/b"]);
  expect(isInside("Ideas/Plan.md", "ideas")).toBe(true);
  expect(isInside("Ideas2/Plan.md", "Ideas")).toBe(false);
  expect(isInside("anything", "")).toBe(true);
  expect(canMoveInto("README.md", "Ideas")).toBe(true);
  expect(canMoveInto("Ideas/Plan.md", "")).toBe(true);
  expect(canMoveInto("Ideas/Plan.md", "Empty")).toBe(true);
  expect(canMoveInto("README.md", "")).toBe(false);
  expect(canMoveInto("Ideas/Plan.md", "ideas")).toBe(false);
  expect(canMoveInto("Ideas", "Ideas")).toBe(false);
  expect(canMoveInto("Ideas", "ideas/Deep")).toBe(false);
  expect(canMoveInto("Ideas", "Ideas2")).toBe(true);
});

test("a new note is created in the chosen folder and opened", async () => {
  vi.mocked(createNote).mockResolvedValue("Ideas/Idea.md");
  const { onChanged } = renderTree();
  fireEvent.click(within(tree()).getByRole("button", { name: "Ideas" }));

  fireEvent.click(screen.getByRole("button", { name: "New note" }));
  const dialog = await screen.findByRole("dialog", { name: "New note" });
  expect(dialog.textContent).toContain("A new note in “Ideas”");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
    target: { value: "Idea" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create note" }));

  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledWith({ open: "Ideas/Idea.md" });
  });
  expect(createNote).toHaveBeenCalledWith("Ideas", "Idea");
});

test("a refused name keeps the dialog open with the reason", async () => {
  vi.mocked(createFolder).mockRejectedValue(
    new CommandFailure("create_folder", { kind: "skippedName" }),
  );
  renderTree();

  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  const dialog = await screen.findByRole("dialog", { name: "New folder" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
    target: { value: "node_modules" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create folder" }),
  );

  await waitFor(() => {
    expect(dialog.textContent).toContain(
      "Liurium leaves out names that start with a dot",
    );
  });
  expect(screen.getByRole("dialog", { name: "New folder" })).toBeDefined();
});

test("F2 renames the focused row; the open note follows", async () => {
  vi.mocked(renameEntry).mockResolvedValue("Roadmap.md");
  const { onChanged } = renderTree("README.md");
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  readme.focus();

  fireEvent.keyDown(readme, { key: "F2" });
  const dialog = await screen.findByRole("dialog", {
    name: "Rename “README.md”",
  });
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  expect((field as HTMLInputElement).value).toBe("README");
  fireEvent.change(field, { target: { value: "Roadmap" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledWith({
      moved: { from: "README.md", to: "Roadmap.md" },
    });
  });
  expect(renameEntry).toHaveBeenCalledWith("README.md", "Roadmap");
});

test("Delete asks first and names the trash; a folder counts its notes", async () => {
  vi.mocked(trashEntry).mockResolvedValue(undefined);
  const { onChanged } = renderTree("Ideas/Plan.md");
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  ideas.focus();

  fireEvent.keyDown(ideas, { key: "Delete" });
  const dialog = await screen.findByRole("dialog", {
    name: "Delete “Ideas”?",
  });
  expect(dialog.textContent).toContain(
    "The folder and everything in it (2 notes) moves to this project's trash, .liurium/trash.",
  );
  expect(trashEntry).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Move to trash" }),
  );

  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledWith({ trashed: "Ideas" });
  });
});

test("Move to… offers every folder except the item itself and its inside", async () => {
  vi.mocked(moveEntry).mockResolvedValue("Empty/Ideas");
  renderTree();

  fireEvent.click(
    within(tree()).getByRole("button", { name: "Actions for Ideas" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
  const dialog = await screen.findByRole("dialog", { name: "Move “Ideas”" });
  const options = within(dialog)
    .getAllByRole("radio")
    .map((radio) => radio.closest("label")?.textContent);
  expect(options).toEqual(["Project folder (top)", "Empty"]);

  fireEvent.click(within(dialog).getByRole("radio", { name: "Empty" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Move here" }));

  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("Ideas", "Empty");
  });
});

test("a filtered tree still counts and moves by the whole project", async () => {
  renderTree(null, { key: "tag", notes: new Set(["Ideas/Plan.md"]) });

  // Folders on the way are open; everything else is gone.
  expect(within(tree()).getByRole("link", { name: "Plan.md" })).toBeDefined();
  expect(within(tree()).queryByRole("link", { name: "README.md" })).toBeNull();
  expect(within(tree()).queryByRole("button", { name: "Empty" })).toBeNull();
  expect(within(tree()).queryByRole("button", { name: "Deep" })).toBeNull();

  // Closing one by hand works here too.
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  expect(ideas.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(ideas);
  expect(ideas.getAttribute("aria-expanded")).toBe("false");
  expect(within(tree()).queryByRole("link", { name: "Plan.md" })).toBeNull();

  // The trash question names every note in the folder, shown or not.
  ideas.focus();
  fireEvent.keyDown(ideas, { key: "Delete" });
  const dialog = await screen.findByRole("dialog", {
    name: "Delete “Ideas”?",
  });
  expect(dialog.textContent).toContain("(2 notes)");
});

test("arrow keys move between rows and open and close folders", () => {
  renderTree();
  const empty = within(tree()).getByRole("button", { name: "Empty" });
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  empty.focus();

  fireEvent.keyDown(empty, { key: "ArrowDown" });
  expect(document.activeElement).toBe(ideas);
  fireEvent.keyDown(ideas, { key: "ArrowRight" });
  expect(ideas.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(ideas, { key: "ArrowRight" });
  const deep = within(tree()).getByRole("button", { name: "Deep" });
  expect(document.activeElement).toBe(deep);
  fireEvent.keyDown(deep, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(ideas);
  fireEvent.keyDown(ideas, { key: "ArrowLeft" });
  expect(ideas.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(ideas, { key: "End" });
  expect(document.activeElement).toBe(
    within(tree()).getByRole("link", { name: "README.md" }),
  );
});

// Dragging uses pointer events (M4-010): jsdom has no layout, so the element under
// the pointer is set by hand.
function pointAt(element: Element | null) {
  document.elementFromPoint = () => element;
}

/** Presses on `from`, moves far enough to drag, over `to`. */
function dragOver(from: HTMLElement, to: Element | null) {
  fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
  pointAt(to);
  fireEvent.pointerMove(window, { clientX: 10, clientY: 40 });
}

function rowOf(element: HTMLElement): HTMLElement {
  const row = element.parentElement;
  if (row === null) {
    throw new Error("no row");
  }
  return row;
}

/** Lets a move that was asked for reach the mock, so "not called" means not called;
 *  the timer also ends the wait for a click after a drag. */
async function settle() {
  await act(async () => {
    await new Promise((done) => {
      window.setTimeout(done, 0);
    });
  });
}

test("a note dragged onto a folder moves there, and the drag opens nothing", async () => {
  vi.mocked(moveEntry).mockResolvedValue("Empty/README.md");
  const { onChanged, history } = renderTree();
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const empty = within(tree()).getByRole("button", { name: "Empty" });

  // Over the folder's name, inside its button.
  dragOver(readme, within(empty).getByText("Empty"));

  expect(rowOf(empty).dataset.drop).toBe("");
  expect(tree().dataset.drop).toBeUndefined();
  expect(readme.dataset.dragged).toBe("");
  // The browser's own drag of a link would take the pointer away.
  expect(readme.getAttribute("draggable")).toBe("false");
  // The name follows the pointer, hidden from screen readers.
  expect(screen.getAllByText("README.md")).toHaveLength(2);

  fireEvent.pointerUp(window);
  fireEvent.click(readme);

  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("README.md", "Empty");
  });
  expect(moveEntry).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledWith({});
  expect(history).toEqual(["/notes"]);
  expect(rowOf(empty).dataset.drop).toBeUndefined();
  expect(readme.dataset.dragged).toBeUndefined();
  expect(screen.getAllByText("README.md")).toHaveLength(1);
});

test("over a note it goes to that note's folder; over the free space, to the top", async () => {
  vi.mocked(moveEntry).mockResolvedValue("x");
  renderTree();
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  fireEvent.click(ideas);
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const plan = within(tree()).getByRole("link", { name: "Plan.md" });

  dragOver(readme, plan);
  expect(rowOf(ideas).dataset.drop).toBe("");
  fireEvent.pointerUp(window);
  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("README.md", "Ideas");
  });

  vi.mocked(moveEntry).mockClear();
  dragOver(plan, tree());
  expect(tree().dataset.drop).toBe("");
  fireEvent.pointerUp(window);
  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("Ideas/Plan.md", "");
  });
});

test("a drag goes nowhere it cannot: into itself, where it is, or off the tree", async () => {
  renderTree();
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  fireEvent.click(ideas);
  const deep = within(tree()).getByRole("button", { name: "Deep" });
  fireEvent.click(deep);
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const plan = within(tree()).getByRole("link", { name: "Plan.md" });
  const marked = () =>
    [tree(), ...tree().querySelectorAll<HTMLElement>("[data-drop]")].filter(
      (element) => element.dataset.drop !== undefined,
    );

  for (const [from, to] of [
    [ideas, ideas],
    [ideas, deep],
    [ideas, within(tree()).getByRole("link", { name: "x.md" })],
    [plan, ideas],
    [plan, deep.closest("li")?.parentElement ?? null],
    [readme, tree()],
    [readme, document.body],
    [plan, document.body],
    [plan, screen.getByRole("button", { name: "New note" })],
    [readme, screen.getByRole("button", { name: "New note" })],
    [readme, null],
  ] as const) {
    dragOver(from, to);
    expect(
      marked(),
      `${from.textContent} over ${to?.textContent ?? "nothing"}`,
    ).toEqual([]);
    fireEvent.pointerUp(window);
  }
  await settle();
  expect(moveEntry).not.toHaveBeenCalled();
});

test("a press that hardly moves is a click, and Escape ends a drag without a move", async () => {
  const { history } = renderTree();
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const empty = within(tree()).getByRole("button", { name: "Empty" });

  fireEvent.pointerDown(readme, { button: 0, clientX: 10, clientY: 10 });
  pointAt(empty);
  fireEvent.pointerMove(window, { clientX: 13, clientY: 13 });
  expect(rowOf(empty).dataset.drop).toBeUndefined();
  fireEvent.pointerUp(window);
  fireEvent.click(readme);
  expect(history).toEqual(["/notes", "/notes/README.md"]);

  dragOver(readme, empty);
  expect(rowOf(empty).dataset.drop).toBe("");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(rowOf(empty).dataset.drop).toBeUndefined();
  fireEvent.pointerUp(window);
  await settle();
  expect(moveEntry).not.toHaveBeenCalled();
});

test("only the main button without keys held starts a drag", async () => {
  renderTree();
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const empty = within(tree()).getByRole("button", { name: "Empty" });

  for (const press of [
    { button: 2 },
    { button: 0, ctrlKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true },
  ]) {
    fireEvent.pointerDown(readme, { ...press, clientX: 10, clientY: 10 });
    pointAt(empty);
    fireEvent.pointerMove(window, { clientX: 10, clientY: 40 });
    expect(rowOf(empty).dataset.drop, JSON.stringify(press)).toBeUndefined();
    fireEvent.pointerUp(window);
  }
  await settle();
  expect(moveEntry).not.toHaveBeenCalled();
});

test("a refused move changes nothing and the tree is read again", async () => {
  vi.mocked(moveEntry).mockRejectedValue(
    new CommandFailure("move_entry", { kind: "skippedName" }),
  );
  const { onChanged } = renderTree();
  dragOver(
    within(tree()).getByRole("link", { name: "README.md" }),
    within(tree()).getByRole("button", { name: "Empty" }),
  );
  fireEvent.pointerUp(window);

  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledWith({});
  });
  expect(moveEntry).toHaveBeenCalledWith("README.md", "Empty");
});

test("near the top or bottom of the pane, a drag scrolls it", async () => {
  const { container } = renderTree();
  container.style.overflowY = "auto";
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 300, left: 0, right: 200, height: 300 }) as DOMRect;
  const scrollBy = vi.fn();
  container.scrollBy = scrollBy;
  const readme = within(tree()).getByRole("link", { name: "README.md" });

  fireEvent.pointerDown(readme, { button: 0, clientX: 10, clientY: 150 });
  pointAt(tree());
  fireEvent.pointerMove(window, { clientX: 10, clientY: 5 });
  await waitFor(() => {
    expect(scrollBy).toHaveBeenCalledWith({ top: -10 });
  });

  scrollBy.mockClear();
  fireEvent.pointerMove(window, { clientX: 10, clientY: 295 });
  await waitFor(() => {
    expect(scrollBy).toHaveBeenCalledWith({ top: 10 });
  });

  const frames = () =>
    new Promise((done) => {
      window.setTimeout(done, 80);
    });
  // In the middle it stays; after letting go it stops.
  fireEvent.pointerMove(window, { clientX: 10, clientY: 150 });
  scrollBy.mockClear();
  await frames();
  expect(scrollBy).not.toHaveBeenCalled();
  fireEvent.pointerMove(window, { clientX: 10, clientY: 5 });
  fireEvent.pointerUp(window);
  scrollBy.mockClear();
  await frames();
  expect(scrollBy).not.toHaveBeenCalled();
});

test("a page around the tree with paths of its own is not a drop target", async () => {
  vi.mocked(moveEntry).mockResolvedValue("Plan.md");
  const { hook } = memoryLocation({ path: "/notes" });
  render(
    <div data-path="Outer" data-kind="folder">
      <Router hook={hook}>
        <NoteTree
          top={TOP}
          openPath={null}
          noteHref={(path) => `/notes/${path}`}
          onChanged={vi.fn()}
        />
      </Router>
    </div>,
  );
  fireEvent.click(within(tree()).getByRole("button", { name: "Ideas" }));

  dragOver(within(tree()).getByRole("link", { name: "Plan.md" }), tree());
  fireEvent.pointerUp(window);

  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("Ideas/Plan.md", "");
  });
});

test("a folder dragged onto another folder moves with what is inside it", async () => {
  vi.mocked(moveEntry).mockResolvedValue("Empty/Ideas");
  const { onChanged } = renderTree("Ideas/Plan.md");
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  const empty = within(tree()).getByRole("button", { name: "Empty" });

  dragOver(ideas, empty);
  expect(ideas.dataset.dragged).toBe("");
  fireEvent.pointerUp(window);
  // The click that ends the drag does not close the folder.
  fireEvent.click(ideas);

  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledWith({
      moved: { from: "Ideas", to: "Empty/Ideas" },
    });
  });
  expect(moveEntry).toHaveBeenCalledWith("Ideas", "Empty");
  expect(ideas.getAttribute("aria-expanded")).toBe("true");
});
