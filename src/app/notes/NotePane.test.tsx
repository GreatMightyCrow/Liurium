import type { ReactElement } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  closeNote,
  reconcileNote,
  createNote,
  type NoteLink,
  noteLinks,
  openExternalLink,
  type NoteMarks,
  openNote,
  type NoteCheck,
  type OpenedNote,
  editProperty,
  propertyKinds,
  resolveNoteConflict,
  setPropertyKind,
  updateNote,
} from "../../lib/ipc/commands";
import { CommandFailure } from "../../lib/ipc/errors";
import { createNoteEditor, type NoteEditorOptions } from "./noteEditor";
import { NotePane } from "./NotePane";
import {
  DRAFT_EVERY_MS,
  flushOpenNote,
  SAVE_AFTER_MS,
  UPDATED_SHOWS_MS,
} from "./useOpenNote";

vi.mock("../../lib/ipc/commands", () => ({
  openNote: vi.fn(),
  updateNote: vi.fn(),
  resolveNoteConflict: vi.fn(),
  closeNote: vi.fn(),
  reconcileNote: vi.fn(),
  noteLinks: vi.fn(),
  openExternalLink: vi.fn(),
  createNote: vi.fn(),
  editProperty: vi.fn(),
  propertyKinds: vi.fn(),
  setPropertyKind: vi.fn(),
  backlinksOf: vi.fn(() => Promise.resolve([])),
}));

// CodeMirror itself runs in the end-to-end tests (real WebView2, real CSP); here a
// stand-in records what the pane hands it.
const fakeEditor = {
  text: vi.fn(() => ""),
  setReadOnly: vi.fn(),
  setMarks: vi.fn(),
  setHidden: vi.fn(),
  replaceFromBox: vi.fn(),
  replaceFromOutside: vi.fn(),
  replace: vi.fn(),
  goTo: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
};
vi.mock("./noteEditor", () => ({
  createNoteEditor: vi.fn(() => fakeEditor),
}));

const onOpen = vi.fn();
const onCreated = vi.fn();
const onTag = vi.fn();
const onClosed = vi.fn();

function pane(path = "Ideas/Plan.md", onMoved = vi.fn(), outside = 0) {
  return (
    <NotePane
      path={path}
      onMoved={onMoved}
      notes={[
        { path: "Ideas/Plan.md", size: 1, modifiedMs: 0, link: "Ideas/Plan" },
        { path: "Unique.md", size: 1, modifiedMs: 0, link: "Unique" },
      ]}
      onOpen={onOpen}
      onCreated={onCreated}
      onTag={onTag}
      onClosed={onClosed}
      outside={outside}
    />
  );
}

const openNoteMock = vi.mocked(openNote);
const updateNoteMock = vi.mocked(updateNote);
const resolveMock = vi.mocked(resolveNoteConflict);
const reconcileMock = vi.mocked(reconcileNote);

function opened(extra: Partial<OpenedNote> = {}): OpenedNote {
  return {
    path: "Ideas/Plan.md",
    text: "# Plan\r\n",
    lineEnding: "crlf",
    readOnly: null,
    unsaved: false,
    conflict: false,
    gone: false,
    revision: 0,
    ...extra,
  };
}

/** The options of the newest editor. */
function editor(): NoteEditorOptions {
  const calls = vi.mocked(createNoteEditor).mock.calls;
  const last = calls.length > 0 ? calls[calls.length - 1] : undefined;
  if (last === undefined) {
    throw new Error("no editor yet");
  }
  return last[1];
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function status() {
  return screen
    .getAllByRole("status")
    .find((element) =>
      [
        "Saved",
        "Not saved yet",
        "Saving…",
        "Changed outside Liurium",
        "Not saved",
        "Deleted outside Liurium",
        "Updated from outside",
      ].includes(element.textContent),
    )?.textContent;
}

/** Waits until the note is open and its editor exists. */
async function noteOpened() {
  await waitFor(() => {
    expect(createNoteEditor).toHaveBeenCalled();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  openNoteMock.mockResolvedValue(opened());
  updateNoteMock.mockResolvedValue("saved");
  vi.mocked(closeNote).mockResolvedValue(undefined);
  vi.mocked(noteLinks).mockResolvedValue({
    links: [],
    tags: [],
    frontTags: [],
    properties: { state: "none" },
  });
  vi.mocked(propertyKinds).mockResolvedValue([]);
  fakeEditor.text.mockReturnValue("# Plan\r\n");
});

afterEach(() => {
  vi.useRealTimers();
});

test("the note opens with its name, folder, text, and line breaks", async () => {
  render(pane("Ideas/Plan.md"));

  await noteOpened();
  expect(screen.getByRole("heading", { name: "Plan.md" })).toBeDefined();
  expect(screen.getByText("Ideas")).toBeDefined();
  expect(status()).toBe("Saved");
  expect(openNoteMock).toHaveBeenCalledWith("Ideas/Plan.md");
  expect(editor()).toMatchObject({
    text: "# Plan\r\n",
    lineBreak: "\r\n",
    readOnly: false,
    label: "Plan.md",
  });
});

test("typing sends a draft soon and saves a second after the last change", async () => {
  render(pane("Ideas/Plan.md"));
  await noteOpened();

  act(() => {
    editor().onChange("# Plan\r\nmore");
  });
  expect(status()).toBe("Not saved yet");

  await wait(DRAFT_EVERY_MS);
  expect(updateNoteMock).toHaveBeenCalledWith(
    "Ideas/Plan.md",
    "# Plan\r\nmore",
    false,
    0,
  );
  act(() => {
    editor().onChange("# Plan\r\nmore text");
  });
  // The fake clock also moves with real time (shouldAdvanceTime), so a slow runner
  // needs some room: still unsaved well before the second is over.
  await wait(SAVE_AFTER_MS - 200);
  expect(updateNoteMock).not.toHaveBeenCalledWith(
    "Ideas/Plan.md",
    expect.any(String),
    true,
    0,
  );

  await wait(200);
  await waitFor(() => {
    expect(status()).toBe("Saved");
  });
  expect(updateNoteMock).toHaveBeenLastCalledWith(
    "Ideas/Plan.md",
    "# Plan\r\nmore text",
    true,
    0,
  );
});

test("Ctrl + S saves at once", async () => {
  render(pane("Ideas/Plan.md"));
  await noteOpened();
  act(() => {
    editor().onChange("now");
  });

  act(() => {
    editor().onSave();
  });

  await waitFor(() => {
    expect(updateNoteMock).toHaveBeenCalledWith(
      "Ideas/Plan.md",
      "now",
      true,
      0,
    );
  });
  expect(status()).toBe("Saved");
});

test("a change made outside shows the choices; keep both moves to the copy", async () => {
  updateNoteMock.mockResolvedValue("conflict");
  resolveMock.mockResolvedValue(opened({ path: "Ideas/Plan (conflict).md" }));
  const onMoved = vi.fn();
  render(pane("Ideas/Plan.md", onMoved));
  await noteOpened();
  act(() => {
    editor().onChange("mine");
    editor().onSave();
  });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This note was changed outside Liurium.");
  expect(status()).toBe("Changed outside Liurium");

  fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
  await waitFor(() => {
    expect(onMoved).toHaveBeenCalledWith("Ideas/Plan (conflict).md");
  });
  expect(resolveMock).toHaveBeenCalledWith("Ideas/Plan.md", "keepBoth");
});

test("loading from disk asks first and then starts the editor over", async () => {
  updateNoteMock.mockResolvedValue("conflict");
  resolveMock.mockResolvedValue(opened({ text: "theirs" }));
  render(pane("Ideas/Plan.md"));
  await noteOpened();
  act(() => {
    editor().onChange("mine");
    editor().onSave();
  });
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Load from disk…" }));
  expect(resolveMock).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Drop my changes" }),
  );

  await waitFor(() => {
    expect(editor().text).toBe("theirs");
  });
  expect(resolveMock).toHaveBeenCalledWith("Ideas/Plan.md", "reload");
  expect(status()).toBe("Saved");
});

test("mixed line endings open read-only and can be made one kind after asking", async () => {
  openNoteMock.mockResolvedValueOnce(
    opened({ lineEnding: "mixed", readOnly: "lineEndings" }),
  );
  render(pane("Ideas/Plan.md"));

  await noteOpened();
  expect(screen.getByText(/mixes Windows and Unix line endings/)).toBeDefined();
  expect(editor()).toMatchObject({ readOnly: true, lineBreak: null });

  fireEvent.click(screen.getByRole("button", { name: "Use one line ending…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Use one line ending" }),
  );

  await waitFor(() => {
    expect(openNoteMock).toHaveBeenLastCalledWith("Ideas/Plan.md", true);
  });
  await waitFor(() => {
    expect(editor().readOnly).toBe(false);
  });
});

test("a note that cannot be opened says why", async () => {
  openNoteMock.mockRejectedValueOnce(
    new CommandFailure("open_note", { kind: "notUtf8" }),
  );
  render(pane("Old.md"));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The note could not be opened");
  expect(alert.textContent).toContain(
    "Liurium can open only UTF-8 text files.",
  );
});

test("a failed save says so and keeps the text", async () => {
  updateNoteMock.mockRejectedValue(
    new CommandFailure("update_note", { kind: "diskFull" }),
  );
  render(pane("Ideas/Plan.md"));
  await noteOpened();
  act(() => {
    editor().onChange("mine");
    editor().onSave();
  });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The disk is full.");
  expect(status()).toBe("Not saved");
});

test("leaving the note and closing the window save the last text", async () => {
  const { unmount } = render(pane("Ideas/Plan.md"));
  await noteOpened();
  act(() => {
    editor().onChange("for the close button");
  });

  await act(() => flushOpenNote());
  expect(updateNoteMock).toHaveBeenCalledWith(
    "Ideas/Plan.md",
    "for the close button",
    true,
    0,
  );

  act(() => {
    editor().onChange("left behind");
  });
  unmount();
  await waitFor(() => {
    expect(updateNoteMock).toHaveBeenLastCalledWith(
      "Ideas/Plan.md",
      "left behind",
      true,
      0,
    );
  });
});

function link(target: NoteLink["target"], from = 0, to = 8): NoteLink {
  return { from, to, target };
}

const BLOCK = "---\r\ndue: 2026-10-20\r\ntags:\r\n  - idee\r\n---\r\n";

function boxMarks(fields: NoteMarks["properties"]): NoteMarks {
  return { links: [], tags: [], frontTags: ["idee"], properties: fields };
}

const FIELDS: NoteMarks["properties"] = {
  state: "fields",
  from: 0,
  to: BLOCK.length,
  fields: [
    { name: "due", value: { kind: "date", text: "2026-10-20" } },
    { name: "tags", value: { kind: "list", items: ["idee"] } },
  ],
};

test("front matter shows in the box, hidden in the editor, and its tags are not in the header", async () => {
  const text = `${BLOCK}Body`;
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(boxMarks(FIELDS));
  render(pane());
  await noteOpened();

  const box = await screen.findByRole("region", { name: "Properties" });
  expect(within(box).getByLabelText("Value of property due")).toHaveProperty(
    "value",
    "2026-10-20",
  );
  expect(screen.queryByRole("list", { name: "Tags" })).toBeNull();
  // Each line break counts as one position in the editor.
  expect(fakeEditor.setHidden).toHaveBeenLastCalledWith({
    from: 0,
    to: BLOCK.length - 5,
  });

  fireEvent.click(within(box).getByRole("button", { name: "idee" }));
  expect(onTag).toHaveBeenCalledWith("idee");
});

test("an edit in the box goes through Rust and into the editor as one change", async () => {
  const text = `${BLOCK}Body`;
  const next = text.replace("2026-10-20", "2027-01-31");
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(boxMarks(FIELDS));
  vi.mocked(editProperty).mockResolvedValue(next);
  render(pane());
  await noteOpened();

  const due = await screen.findByLabelText("Value of property due");
  fireEvent.change(due, { target: { value: "2027-01-31" } });
  fireEvent.blur(due);

  await waitFor(() => {
    expect(fakeEditor.replaceFromBox).toHaveBeenCalled();
  });
  expect(editProperty).toHaveBeenCalledWith(text, {
    action: "set",
    name: "due",
    value: { kind: "date", text: "2027-01-31" },
  });
  // Only what differs, in editor positions (one line break before it).
  expect(fakeEditor.replaceFromBox).toHaveBeenCalledWith(12, 19, "7-01-31");
});

test("a refused edit says why and changes nothing", async () => {
  const text = `${BLOCK}Body`;
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(boxMarks(FIELDS));
  vi.mocked(editProperty).mockRejectedValue(
    new CommandFailure("edit_property", { kind: "propertyRefused" }),
  );
  render(pane());
  await noteOpened();

  const add = await screen.findByLabelText("Add to tags");
  fireEvent.change(add, { target: { value: "neu" } });
  fireEvent.keyDown(add, { key: "Enter" });

  expect((await screen.findByRole("alert")).textContent).toMatch(
    /^Liurium could not make this change/,
  );
  expect(fakeEditor.replaceFromBox).not.toHaveBeenCalled();
});

test("Edit as text shows the block in the note, with its tags in the header, and back", async () => {
  const text = `${BLOCK}Body`;
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(boxMarks(FIELDS));
  render(pane());
  await noteOpened();

  fireEvent.click(await screen.findByRole("button", { name: "Edit as text" }));

  expect(screen.queryByRole("region", { name: "Properties" })).toBeNull();
  expect(fakeEditor.setHidden).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole("list", { name: "Tags" })).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Show as properties" }));

  expect(screen.getByRole("region", { name: "Properties" })).toBeDefined();
  expect(fakeEditor.setHidden).toHaveBeenLastCalledWith({
    from: 0,
    to: BLOCK.length - 5,
  });
});

test("front matter Liurium cannot judge stays as text and says so", async () => {
  fakeEditor.text.mockReturnValue("---\nbad: [\n---\nBody");
  vi.mocked(noteLinks).mockResolvedValue(boxMarks({ state: "asText" }));
  render(pane());
  await noteOpened();

  expect(
    await screen.findByText(/^This front matter cannot show as properties/),
  ).toBeDefined();
  expect(screen.queryByRole("region", { name: "Properties" })).toBeNull();
  expect(fakeEditor.setHidden).toHaveBeenLastCalledWith(null);
});

test("a block without a line break after it is not hidden", async () => {
  const text = "---\na: 1\n---";
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(
    boxMarks({
      state: "fields",
      from: 0,
      to: text.length,
      fields: [{ name: "a", value: { kind: "number", text: "1" } }],
    }),
  );
  render(pane());
  await noteOpened();

  await screen.findByRole("region", { name: "Properties" });
  expect(fakeEditor.setHidden).toHaveBeenLastCalledWith(null);
});

test("a note without properties offers only Add property", async () => {
  render(pane());
  await noteOpened();

  const box = await screen.findByRole("region", { name: "Properties" });
  expect(within(box).queryByRole("heading")).toBeNull();
  expect(
    within(box).getByRole("button", { name: "Add property" }),
  ).toBeDefined();
});

test("a new property is written with its kind, and the kind is kept for the project", async () => {
  vi.mocked(editProperty).mockResolvedValue("---\r\ndue:\r\n---\r\n# Plan\r\n");
  vi.mocked(setPropertyKind).mockResolvedValue(undefined);
  render(pane());
  await noteOpened();

  fireEvent.click(await screen.findByRole("button", { name: "Add property" }));
  fireEvent.change(screen.getByLabelText("Name of the new property"), {
    target: { value: " due " },
  });
  fireEvent.change(screen.getByLabelText("Kind of the new property"), {
    target: { value: "date" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => {
    expect(setPropertyKind).toHaveBeenCalledWith("due", "date");
  });
  expect(editProperty).toHaveBeenCalledWith("# Plan\r\n", {
    action: "set",
    name: "due",
    value: { kind: "empty" },
  });
});

test("a chosen kind changes how a value shows, and a value that does not fit says so", async () => {
  const text = "---\ndue: soon\ncount: 5\n---\n";
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(propertyKinds).mockResolvedValue([
    { name: "DUE", kind: "date" },
    { name: "count", kind: "text" },
  ]);
  vi.mocked(noteLinks).mockResolvedValue(
    boxMarks({
      state: "fields",
      from: 0,
      to: text.length,
      fields: [
        { name: "due", value: { kind: "text", text: "soon" } },
        { name: "count", value: { kind: "number", text: "5" } },
      ],
    }),
  );
  render(pane());
  await noteOpened();

  expect(await screen.findByText(/^Not a date\./)).toBeDefined();
  expect(screen.getByLabelText("Value of property due")).toHaveProperty(
    "value",
    "soon",
  );
  expect(screen.getByLabelText("Value of property count")).toHaveProperty(
    "value",
    "5",
  );
  expect(editProperty).not.toHaveBeenCalled();
});

test("a read-only note shows its properties without controls", async () => {
  openNoteMock.mockResolvedValue(opened({ readOnly: "file" }));
  const text = `${BLOCK}Body`;
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue(boxMarks(FIELDS));
  render(pane());
  await noteOpened();

  const box = await screen.findByRole("region", { name: "Properties" });
  expect(within(box).queryByRole("button", { name: "Remove idee" })).toBeNull();
  expect(
    within(box).queryByRole("button", { name: "Add property" }),
  ).toBeNull();
  expect(within(box).queryByLabelText("Add to tags")).toBeNull();
  expect(within(box).getByLabelText("Value of property due")).toHaveProperty(
    "readOnly",
    true,
  );
});

test("the note's tags show once in its header and choose that tag", async () => {
  const text = "a\r\n#idee #Idee";
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue({
    links: [],
    tags: [
      { from: 3, to: 8, tag: "idee" },
      { from: 9, to: 14, tag: "Idee" },
    ],
    frontTags: ["project/sub"],
    properties: { state: "none" },
  });
  render(pane());
  await noteOpened();

  const list = await screen.findByRole("list", { name: "Tags" });
  expect(
    within(list)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["#project/sub", "#idee"]);
  // The editor counts the line break as one position.
  expect(fakeEditor.setMarks).toHaveBeenCalledWith(
    [],
    [
      { from: 2, to: 7, tag: "idee" },
      { from: 8, to: 13, tag: "Idee" },
    ],
  );

  fireEvent.click(screen.getByRole("button", { name: "#idee" }));
  expect(onTag).toHaveBeenCalledWith("idee");
});

test("Rust's links reach the editor, CRLF counted as one position", async () => {
  const text = "a\r\n[[Unique]]";
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue({
    links: [
      link(
        { state: "note", path: "Unique.md", heading: null, block: null },
        3,
        13,
      ),
    ],
    tags: [],
    frontTags: [],
    properties: { state: "none" },
  });
  render(pane());
  await noteOpened();

  await waitFor(() => {
    expect(fakeEditor.setMarks).toHaveBeenCalledWith(
      [
        link(
          { state: "note", path: "Unique.md", heading: null, block: null },
          2,
          12,
        ),
      ],
      [],
    );
  });
  expect(noteLinks).toHaveBeenCalledWith("Ideas/Plan.md", text);
  expect(
    editor()
      .suggestions()
      .map((suggestion) => suggestion.link),
  ).toEqual(["Ideas/Plan", "Unique"]);
});

test("following a note link opens it; a heading in the same note scrolls there", async () => {
  fakeEditor.text.mockReturnValue("# Plan\r\n\r\n## Next steps\r\n");
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(
      link({ state: "note", path: "Unique.md", heading: null, block: null }),
    );
  });
  expect(onOpen).toHaveBeenCalledWith("Unique.md");

  act(() => {
    editor().onFollow(
      link({
        state: "note",
        path: "ideas/plan.md",
        heading: "next-steps",
        block: null,
      }),
    );
  });
  // "# Plan\r\n\r\n" is 10 units, 8 positions in the editor.
  expect(fakeEditor.goTo).toHaveBeenCalledWith(8);
});

test("an ambiguous link asks which note and writes its path into the link", async () => {
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(
      link(
        {
          state: "ambiguous",
          candidates: [
            { path: "Ideas/Plan.md", replacement: "[[Ideas/Plan]]" },
            { path: "Plan.md", replacement: "[[Plan.md]]" },
          ],
        },
        4,
        12,
      ),
    );
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Which note does this link mean?",
  });
  fireEvent.click(screen.getByRole("radio", { name: "Plan.md" }));
  fireEvent.click(screen.getByRole("button", { name: "Use this note" }));

  expect(fakeEditor.replace).toHaveBeenCalledWith(4, 12, "[[Plan.md]]");
  expect(onOpen).toHaveBeenCalledWith("Plan.md");
  await waitFor(() => {
    expect(dialog.isConnected).toBe(false);
  });
});

test("a missing note is created after asking, then opened", async () => {
  vi.mocked(createNote).mockResolvedValue("Ideas/Neue Idee.md");
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(link({ state: "missing", path: "Ideas/Neue Idee.md" }));
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Create “Neue Idee.md”?",
  });
  expect(dialog.textContent).toContain("in “Ideas”");
  expect(createNote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));

  await waitFor(() => {
    expect(onOpen).toHaveBeenCalledWith("Ideas/Neue Idee.md");
  });
  expect(createNote).toHaveBeenCalledWith("Ideas", "Neue Idee.md");
  expect(onCreated).toHaveBeenCalled();
});

// Changes made outside (M3-008). The count on the pane is what the page's wait for
// Rust's signal raises.

async function changedOutside(
  rerender: (ui: ReactElement) => void,
  onMoved = vi.fn(),
) {
  await act(async () => {
    rerender(pane("Ideas/Plan.md", onMoved, 1));
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("a change outside without unsaved text takes over the text and keeps the editor", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "reloaded",
    note: opened({ text: "# Plan\r\nfrom outside\r\n", revision: 1 }),
  });
  const { rerender } = render(pane());
  await noteOpened();
  const editors = vi.mocked(createNoteEditor).mock.calls.length;

  await changedOutside(rerender);

  await waitFor(() => {
    expect(status()).toBe("Updated from outside");
  });
  expect(fakeEditor.replaceFromOutside).toHaveBeenCalledWith(
    7,
    7,
    "from outside\r\n",
  );
  expect(vi.mocked(createNoteEditor).mock.calls).toHaveLength(editors);
  expect(updateNoteMock).not.toHaveBeenCalled();

  await wait(UPDATED_SHOWS_MS);
  expect(status()).toBe("Saved");
});

test("after a reload, new text is sent with the new revision", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "reloaded",
    note: opened({ text: "theirs", revision: 3 }),
  });
  const { rerender } = render(pane());
  await noteOpened();
  await changedOutside(rerender);
  await waitFor(() => {
    expect(status()).toBe("Updated from outside");
  });

  act(() => {
    editor().onChange("theirs and mine");
    editor().onSave();
  });

  await waitFor(() => {
    expect(updateNoteMock).toHaveBeenLastCalledWith(
      "Ideas/Plan.md",
      "theirs and mine",
      true,
      3,
    );
  });
});

test("a new line break kind starts a new editor", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "reloaded",
    note: opened({ text: "lf\n", lineEnding: "lf", revision: 1 }),
  });
  const { rerender } = render(pane());
  await noteOpened();

  await changedOutside(rerender);

  await waitFor(() => {
    expect(editor().lineBreak).toBe("\n");
  });
  expect(editor().text).toBe("lf\n");
  expect(fakeEditor.replaceFromOutside).not.toHaveBeenCalled();
});

test("unsent typing reaches Rust before it looks at the file", async () => {
  const order: string[] = [];
  updateNoteMock.mockImplementation(() => {
    order.push("text");
    return Promise.resolve("draft");
  });
  reconcileMock.mockImplementation(() => {
    order.push("look");
    return Promise.resolve({
      outcome: "conflict",
      note: opened({ text: "mine", unsaved: true, conflict: true }),
    });
  });
  const { rerender } = render(pane());
  await noteOpened();
  act(() => {
    editor().onChange("mine");
  });

  await changedOutside(rerender);

  await screen.findByRole("alert");
  expect(order.slice(0, 2)).toEqual(["text", "look"]);
  expect(updateNoteMock).toHaveBeenCalledWith(
    "Ideas/Plan.md",
    "mine",
    false,
    0,
  );
  expect(status()).toBe("Changed outside Liurium");
  expect(fakeEditor.replaceFromOutside).not.toHaveBeenCalled();
});

test("typing during the look becomes a conflict and stays in the editor", async () => {
  const answers: ((check: NoteCheck) => void)[] = [];
  reconcileMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  );
  const { rerender } = render(pane());
  await noteOpened();
  await changedOutside(rerender);

  act(() => {
    editor().onChange("typed meanwhile");
  });
  await act(async () => {
    answers[0]?.({
      outcome: "reloaded",
      note: opened({ text: "theirs", revision: 1 }),
    });
    await vi.advanceTimersByTimeAsync(0);
  });

  await waitFor(() => {
    expect(updateNoteMock).toHaveBeenCalledWith(
      "Ideas/Plan.md",
      "typed meanwhile",
      false,
      0,
    );
  });
  expect(fakeEditor.replaceFromOutside).not.toHaveBeenCalled();
  expect(status()).toBe("Changed outside Liurium");
});

test("a look that finds nothing leaves the status alone", async () => {
  reconcileMock.mockResolvedValue({ outcome: "same", note: opened() });
  const { rerender } = render(pane());
  await noteOpened();
  act(() => {
    editor().onChange("mine");
  });

  await changedOutside(rerender);

  await waitFor(() => {
    expect(reconcileMock).toHaveBeenCalled();
  });
  expect(status()).toBe("Not saved yet");
});

test("a note deleted outside offers to create it again", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "gone",
    note: opened({ gone: true }),
  });
  resolveMock.mockResolvedValue(opened());
  const { rerender } = render(pane());
  await noteOpened();

  await changedOutside(rerender);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("deleted or moved outside Liurium");
  expect(status()).toBe("Deleted outside Liurium");

  fireEvent.click(screen.getByRole("button", { name: "Create again" }));
  await waitFor(() => {
    expect(resolveMock).toHaveBeenCalledWith("Ideas/Plan.md", "overwrite");
  });
  await waitFor(() => {
    expect(status()).toBe("Saved");
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("while a note is deleted, typing keeps the bar and is not reported as saved", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "gone",
    note: opened({ gone: true }),
  });
  updateNoteMock.mockResolvedValue("gone");
  const { rerender } = render(pane());
  await noteOpened();
  await changedOutside(rerender);
  await screen.findByRole("alert");

  act(() => {
    editor().onChange("mine");
    editor().onSave();
  });

  await waitFor(() => {
    expect(updateNoteMock).toHaveBeenCalledWith(
      "Ideas/Plan.md",
      "mine",
      true,
      0,
    );
  });
  expect(status()).toBe("Deleted outside Liurium");
  expect(screen.getByRole("button", { name: "Create again" })).toBeDefined();
});

test("closing a deleted note without unsaved text does not ask", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "gone",
    note: opened({ gone: true }),
  });
  const { rerender } = render(pane());
  await noteOpened();
  await changedOutside(rerender);
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  await waitFor(() => {
    expect(onClosed).toHaveBeenCalled();
  });
  expect(closeNote).toHaveBeenCalledWith("Ideas/Plan.md", false);
});

test("closing a deleted note with unsaved text asks first", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "gone",
    note: opened({ gone: true, unsaved: true, text: "mine" }),
  });
  updateNoteMock.mockResolvedValue("gone");
  const { rerender } = render(pane());
  await noteOpened();
  act(() => {
    editor().onChange("mine");
  });
  await changedOutside(rerender);
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  const drop = await screen.findByRole("button", { name: "Drop my text" });
  expect(closeNote).not.toHaveBeenCalled();
  expect(onClosed).not.toHaveBeenCalled();

  fireEvent.click(drop);

  await waitFor(() => {
    expect(onClosed).toHaveBeenCalled();
  });
  expect(closeNote).toHaveBeenCalledWith("Ideas/Plan.md", true);
});

test("a deleted note in a write-protected project cannot be created again", async () => {
  openNoteMock.mockResolvedValue(opened({ readOnly: "project" }));
  reconcileMock.mockResolvedValue({
    outcome: "gone",
    note: opened({ gone: true, readOnly: "project" }),
  });
  const { rerender } = render(pane());
  await noteOpened();

  await changedOutside(rerender);

  await waitFor(() => {
    expect(status()).toBe("Deleted outside Liurium");
  });
  expect(screen.queryByRole("button", { name: "Create again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
});

test("a note renamed outside moves on", async () => {
  reconcileMock.mockResolvedValue({
    outcome: "moved",
    note: opened({ path: "Ideas/Moved.md" }),
  });
  const onMoved = vi.fn();
  const { rerender } = render(pane("Ideas/Plan.md", onMoved));
  await noteOpened();

  await changedOutside(rerender, onMoved);

  await waitFor(() => {
    expect(onMoved).toHaveBeenCalledWith("Ideas/Moved.md");
  });
});

// External links (M3-012).

function externalLink(claims: string | null): NoteLink {
  return {
    from: 0,
    to: 5,
    target: { state: "external", address: "https://example.org/", claims },
  };
}

test("an honest external link opens at once", async () => {
  vi.mocked(openExternalLink).mockResolvedValue(undefined);
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(externalLink(null));
  });

  expect(openExternalLink).toHaveBeenCalledWith("https://example.org/");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a link claiming another address asks first, and Cancel opens nothing", async () => {
  vi.mocked(openExternalLink).mockResolvedValue(undefined);
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(externalLink("www.meinebank.de"));
  });

  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("www.meinebank.de");
  expect(dialog.textContent).toContain("https://example.org/");
  expect(openExternalLink).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(openExternalLink).not.toHaveBeenCalled();

  act(() => {
    editor().onFollow(externalLink("www.meinebank.de"));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open address" }));
  await waitFor(() => {
    expect(openExternalLink).toHaveBeenCalledWith("https://example.org/");
  });
});

test("a link that does not open says why", async () => {
  vi.mocked(openExternalLink).mockRejectedValue(
    new CommandFailure("open_external_link", { kind: "linkNotOpened" }),
  );
  render(pane());
  await noteOpened();

  act(() => {
    editor().onFollow(externalLink(null));
  });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The link did not open.");
  expect(alert.textContent).toContain("Windows could not open this address.");
});
