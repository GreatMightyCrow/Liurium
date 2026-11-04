import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  closeNote,
  createNote,
  type NoteLink,
  noteLinks,
  openNote,
  type OpenedNote,
  resolveNoteConflict,
  updateNote,
} from "../../lib/ipc/commands";
import { CommandFailure } from "../../lib/ipc/errors";
import { createNoteEditor, type NoteEditorOptions } from "./noteEditor";
import { NotePane } from "./NotePane";
import { DRAFT_EVERY_MS, flushOpenNote, SAVE_AFTER_MS } from "./useOpenNote";

vi.mock("../../lib/ipc/commands", () => ({
  openNote: vi.fn(),
  updateNote: vi.fn(),
  resolveNoteConflict: vi.fn(),
  closeNote: vi.fn(),
  noteLinks: vi.fn(),
  createNote: vi.fn(),
  backlinksOf: vi.fn(() => Promise.resolve([])),
}));

// CodeMirror itself runs in the end-to-end tests (real WebView2, real CSP); here a
// stand-in records what the pane hands it.
const fakeEditor = {
  text: vi.fn(() => ""),
  setReadOnly: vi.fn(),
  setLinks: vi.fn(),
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

function pane(path = "Ideas/Plan.md", onMoved = vi.fn()) {
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
    />
  );
}

const openNoteMock = vi.mocked(openNote);
const updateNoteMock = vi.mocked(updateNote);
const resolveMock = vi.mocked(resolveNoteConflict);

function opened(extra: Partial<OpenedNote> = {}): OpenedNote {
  return {
    path: "Ideas/Plan.md",
    text: "# Plan\r\n",
    lineEnding: "crlf",
    readOnly: null,
    unsaved: false,
    conflict: false,
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
  vi.mocked(noteLinks).mockResolvedValue([]);
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
  );
  act(() => {
    editor().onChange("# Plan\r\nmore text");
  });
  await wait(SAVE_AFTER_MS - 1);
  expect(updateNoteMock).not.toHaveBeenCalledWith(
    "Ideas/Plan.md",
    expect.any(String),
    true,
  );

  await wait(1);
  await waitFor(() => {
    expect(status()).toBe("Saved");
  });
  expect(updateNoteMock).toHaveBeenLastCalledWith(
    "Ideas/Plan.md",
    "# Plan\r\nmore text",
    true,
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
    expect(updateNoteMock).toHaveBeenCalledWith("Ideas/Plan.md", "now", true);
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
    );
  });
});

function link(target: NoteLink["target"], from = 0, to = 8): NoteLink {
  return { from, to, target };
}

test("Rust's links reach the editor, CRLF counted as one position", async () => {
  const text = "a\r\n[[Unique]]";
  fakeEditor.text.mockReturnValue(text);
  vi.mocked(noteLinks).mockResolvedValue([
    link(
      { state: "note", path: "Unique.md", heading: null, block: null },
      3,
      13,
    ),
  ]);
  render(pane());
  await noteOpened();

  await waitFor(() => {
    expect(fakeEditor.setLinks).toHaveBeenCalledWith([
      link(
        { state: "note", path: "Unique.md", heading: null, block: null },
        2,
        12,
      ),
    ]);
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
