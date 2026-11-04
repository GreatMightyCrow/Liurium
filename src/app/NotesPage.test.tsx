import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  listNotes,
  type NoteEntry,
  type NotesView,
  type SkippedNotes,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import {
  NotesPage,
  noteHref,
  notePathOf,
  SHOWN_NOTES,
  skippedText,
} from "./NotesPage";

vi.mock("../lib/ipc/commands", () => ({ listNotes: vi.fn() }));

const listNotesMock = vi.mocked(listNotes);

const NOTHING_SKIPPED: SkippedNotes = {
  linksOutside: 0,
  brokenLinks: 0,
  badNames: 0,
  unreadable: 0,
  tooDeep: 0,
  depthLimit: 64,
};

function note(path: string): NoteEntry {
  return { path, size: 10, modifiedMs: Date.UTC(2026, 10, 4, 9, 30) };
}

function ready(
  notes: NoteEntry[],
  extra: Partial<Extract<NotesView, { state: "ready" }>> = {},
): NotesView {
  return {
    state: "ready",
    notes,
    skipped: NOTHING_SKIPPED,
    truncated: false,
    noteLimit: 100_000,
    emptyFolders: [],
    ...extra,
  };
}

function Location() {
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
}

function renderPage(path = "/notes") {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <NotesPage />
      <Location />
    </Router>,
  );
}

function tree() {
  return screen.getByRole("navigation", { name: "Notes in this project" });
}

beforeEach(() => {
  listNotesMock.mockReset();
});

test("while Rust walks the project, the page says it is looking", () => {
  listNotesMock.mockReturnValue(new Promise(() => undefined));

  renderPage();

  expect(screen.getByRole("status").textContent).toBe("Looking for notes…");
});

test("the notes are counted and shown as a tree, folders first and closed", async () => {
  listNotesMock.mockResolvedValue(
    ready([note("Ideas/Plan.md"), note("README.md"), note("Ideas/Deep/x.md")]),
  );

  renderPage();

  expect(await screen.findByText("3 notes")).toBeDefined();
  const ideas = within(tree()).getByRole("button", { name: "Ideas" });
  expect(ideas.getAttribute("aria-expanded")).toBe("false");
  expect(
    within(tree())
      .getByRole("link", { name: "README.md" })
      .getAttribute("href"),
  ).toBe("/notes/README.md");
  expect(within(tree()).queryByRole("link", { name: "Plan.md" })).toBeNull();

  fireEvent.click(ideas);
  expect(ideas.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(tree()).getByRole("link", { name: "Plan.md" }).getAttribute("href"),
  ).toBe("/notes/Ideas/Plan.md");
  expect(within(tree()).getByRole("button", { name: "Deep" })).toBeDefined();
  expect(
    screen.getByText("Choose a note on the left to open it."),
  ).toBeDefined();
});

test("the folders above the open note start open, and the note is marked", async () => {
  listNotesMock.mockResolvedValue(ready([note("Ideas/Deep/x.md")]));

  renderPage("/notes/Ideas/Deep/x.md");

  await screen.findByText("1 note");
  const link = within(tree()).getByRole("link", { name: "x.md" });
  expect(link.getAttribute("aria-current")).toBe("page");
});

test("empty folders show up too", async () => {
  listNotesMock.mockResolvedValue(ready([], { emptyFolders: ["New"] }));

  renderPage();

  expect(await screen.findByText("No notes yet")).toBeDefined();
  expect(within(tree()).getByRole("button", { name: "New" })).toBeDefined();
  expect(screen.getByRole("button", { name: "New note" })).toBeDefined();
});

test("one note is counted in the singular", async () => {
  listNotesMock.mockResolvedValue(ready([note("a.md")]));

  renderPage();

  expect(await screen.findByText("1 note")).toBeDefined();
});

test("skipped items and the note limit are said in plain words", async () => {
  listNotesMock.mockResolvedValue(
    ready([note("a.md")], {
      truncated: true,
      skipped: { ...NOTHING_SKIPPED, linksOutside: 2, badNames: 1 },
    }),
  );

  renderPage();

  await screen.findByText("1 note");
  const status = screen.getByRole("status");
  expect(status.textContent).toContain(
    "This project holds more than 100,000 notes. Liurium lists the first 100,000.",
  );
  expect(status.textContent).toContain(
    "Not included: 2 links leading outside the project, 1 name that Windows does not allow.",
  );
});

test("every skip reason has its own words", () => {
  expect(skippedText(NOTHING_SKIPPED)).toBeNull();
  expect(
    skippedText({
      linksOutside: 1,
      brokenLinks: 3,
      badNames: 2,
      unreadable: 1,
      tooDeep: 1,
      depthLimit: 64,
    }),
  ).toBe(
    "Not included: 1 link leading outside the project, 3 links leading nowhere, 2 names that Windows does not allow, 1 item Liurium could not read, 1 folder nested deeper than 64 levels.",
  );
});

test(`only the first ${String(SHOWN_NOTES)} notes are listed, the rest are counted`, async () => {
  const many = Array.from({ length: SHOWN_NOTES + 5 }, (_, n) =>
    note(`n${String(n).padStart(4, "0")}.md`),
  );
  listNotesMock.mockResolvedValue(ready(many));

  renderPage();

  expect(await screen.findByText("1,005 notes")).toBeDefined();
  expect(within(tree()).getAllByRole("link")).toHaveLength(SHOWN_NOTES);
  expect(screen.getByText("And 5 more notes not shown here.")).toBeDefined();
  // A thousand real rows in jsdom took 7 s on the CI runner before the shared row
  // menu (M3-004), 1.5 s locally after it; the default 5 s is too tight for jsdom
  // there, not for the app.
}, 20_000);

test("without an open project the page leads to Projects", async () => {
  listNotesMock.mockResolvedValue({ state: "noProject" });

  renderPage();

  fireEvent.click(
    await screen.findByRole("button", { name: "Go to Projects" }),
  );
  expect(screen.getByTestId("location").textContent).toBe("/projects");
});

test("a failure is explained without raw error text", async () => {
  listNotesMock.mockRejectedValue(
    new CommandFailure("list_notes", { kind: "locked" }),
  );

  renderPage();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Notes could not be listed");
  expect(alert.textContent).toContain("Another program is using this data.");
});

test("note addresses encode each part and decode back", () => {
  expect(noteHref("My Notes/Plan v2.md")).toBe(
    "/notes/My%20Notes/Plan%20v2.md",
  );
  expect(notePathOf("/notes/My%20Notes/Plan%20v2.md")).toBe(
    "My Notes/Plan v2.md",
  );
  expect(notePathOf("/notes")).toBeNull();
  expect(notePathOf("/notes/%E0%A4%A")).toBeNull();
});
