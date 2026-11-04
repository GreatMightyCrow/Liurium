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
import { byFolder, NotesPage, SHOWN_NOTES, skippedText } from "./NotesPage";

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
    ...extra,
  };
}

function Location() {
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/notes" });
  return render(
    <Router hook={hook}>
      <NotesPage />
      <Location />
    </Router>,
  );
}

beforeEach(() => {
  listNotesMock.mockReset();
});

test("while Rust walks the project, the page says it is looking", () => {
  listNotesMock.mockReturnValue(new Promise(() => undefined));

  renderPage();

  expect(screen.getByRole("status").textContent).toBe("Looking for notes…");
});

test("the notes are counted and listed by folder, top level first", async () => {
  listNotesMock.mockResolvedValue(
    ready([note("Ideas/Plan.md"), note("README.md"), note("ideas/b/x.md")]),
  );

  renderPage();

  expect(await screen.findByText("3 notes")).toBeDefined();
  const folders = screen.getAllByRole("region");
  expect(folders.map((folder) => folder.getAttribute("aria-label"))).toEqual([
    "Project folder",
    "Ideas",
    "ideas/b",
  ]);
  expect(
    within(folders[1])
      .getAllByRole("listitem")
      .map((item) => item.querySelector("span")?.textContent),
  ).toEqual(["Plan.md"]);
  const time = within(folders[0]).getByText(/2026/);
  expect(time.getAttribute("datetime")).toBe("2026-11-04T09:30:00.000Z");
  expect(screen.queryByRole("status")).toBeNull();
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
  expect(screen.getAllByRole("listitem")).toHaveLength(SHOWN_NOTES);
  expect(screen.getByText("And 5 more notes not shown here.")).toBeDefined();
});

test("a project without notes says where Liurium looked", async () => {
  listNotesMock.mockResolvedValue(ready([]));

  renderPage();

  expect(
    await screen.findByRole("heading", {
      name: "No notes in this project yet",
    }),
  ).toBeDefined();
  expect(screen.queryByRole("list")).toBeNull();
});

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

test("folders group by their exact path, the top level first", () => {
  const folders = byFolder([note("b/x.md"), note("y.md"), note("A/z.md")]);

  expect(folders.map((folder) => folder.path)).toEqual(["", "A", "b"]);
  expect(folders[0].notes[0].name).toBe("y.md");
});
