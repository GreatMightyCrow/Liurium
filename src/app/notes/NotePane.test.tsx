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
}));

// CodeMirror itself runs in the end-to-end tests (real WebView2, real CSP); here a
// stand-in records what the pane hands it.
vi.mock("./noteEditor", () => ({
  createNoteEditor: vi.fn(() => ({
    text: () => "",
    setReadOnly: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
  })),
}));

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
});

afterEach(() => {
  vi.useRealTimers();
});

test("the note opens with its name, folder, text, and line breaks", async () => {
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);

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
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);
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
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);
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
  render(<NotePane path="Ideas/Plan.md" onMoved={onMoved} />);
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
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);
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
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);

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
  render(<NotePane path="Old.md" onMoved={vi.fn()} />);

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
  render(<NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />);
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
  const { unmount } = render(
    <NotePane path="Ideas/Plan.md" onMoved={vi.fn()} />,
  );
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
