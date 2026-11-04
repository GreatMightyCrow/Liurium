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

function renderTree(openPath: string | null = null) {
  const onChanged = vi.fn();
  const { hook } = memoryLocation({ path: "/notes" });
  render(
    <Router hook={hook}>
      <NoteTree
        top={TOP}
        openPath={openPath}
        noteHref={(path) => `/notes/${path}`}
        onChanged={onChanged}
      />
    </Router>,
  );
  return { onChanged };
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

test("a note dropped on a folder moves there; a folder never into itself", async () => {
  vi.mocked(moveEntry).mockResolvedValue("Empty/README.md");
  const { onChanged } = renderTree();
  const readme = within(tree()).getByRole("link", { name: "README.md" });
  const empty = within(tree()).getByRole("button", { name: "Empty" });
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  const data = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };

  fireEvent.dragStart(readme, { dataTransfer });
  fireEvent.dragOver(empty, { dataTransfer });
  fireEvent.drop(empty, { dataTransfer });

  await waitFor(() => {
    expect(moveEntry).toHaveBeenCalledWith("README.md", "Empty");
  });
  expect(onChanged).toHaveBeenCalledWith({});

  vi.mocked(moveEntry).mockClear();
  fireEvent.click(ideas);
  const deep = within(tree()).getByRole("button", { name: "Deep" });
  data.clear();
  fireEvent.dragStart(ideas, { dataTransfer });
  act(() => {
    fireEvent.drop(deep, { dataTransfer });
  });
  expect(moveEntry).not.toHaveBeenCalled();
});
