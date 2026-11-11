import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  listNotes,
  type NoteEntry,
  type NotesView,
  waitNoteChanges,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { DashboardPage } from "./DashboardPage";
import { RECENT_NOTES, recentNotes } from "./dashboard/RecentNotes";
import {
  useWidgetData,
  WidgetContent,
  type WidgetDefinition,
} from "./dashboard/widget";
import { dashboardWidgets } from "./dashboard/widgets";

vi.mock("../lib/ipc/commands", () => ({
  listNotes: vi.fn(),
  waitNoteChanges: vi.fn(),
  checkNoteChanges: vi.fn(() => Promise.resolve()),
}));

const listNotesMock = vi.mocked(listNotes);
const waitMock = vi.mocked(waitNoteChanges);

function note(path: string, minute: number): NoteEntry {
  return {
    path,
    size: 10,
    modifiedMs: Date.UTC(2026, 10, 11, 9, minute),
    link: path,
  };
}

function ready(notes: NoteEntry[]): NotesView {
  return {
    state: "ready",
    notes,
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
  };
}

beforeEach(() => {
  listNotesMock.mockReset();
  // No outside change unless a test says so.
  waitMock.mockReset().mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDashboard(widgets?: readonly WidgetDefinition[]) {
  const memory = memoryLocation({ path: "/", record: true });
  render(
    <Router hook={memory.hook}>
      <DashboardPage widgets={widgets} />
    </Router>,
  );
  return memory;
}

function widget(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

test("the dashboard is the start page and shows its widgets as named sections", async () => {
  listNotesMock.mockResolvedValue(ready([note("Plan.md", 1)]));
  renderDashboard();
  expect(
    screen.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeDefined();
  expect(dashboardWidgets.map((each) => each.id)).toEqual(["recentNotes"]);
  const recent = widget("Recent notes");
  expect(
    within(recent).getByRole("heading", { level: 2, name: "Recent notes" }),
  ).toBeDefined();
  expect(recent.getAttribute("data-size")).toBe("normal");
  await within(recent).findByRole("link", { name: /Plan\.md/ });
});

test("recent notes lists the last changed notes first, each opening its note", async () => {
  const notes = [
    note("Old.md", 1),
    note("Ideas/Plan.md", 30),
    note("Ideas/Deep/Next week.md", 20),
    ...Array.from({ length: 10 }, (_, at) =>
      note(`Filler ${String(at)}.md`, 2 + at),
    ),
  ];
  listNotesMock.mockResolvedValue(ready(notes));
  const memory = renderDashboard();
  const recent = widget("Recent notes");
  expect(within(recent).getByRole("status").textContent).toBe("Loading notes…");

  const links = await within(recent).findAllByRole("link");
  expect(links).toHaveLength(RECENT_NOTES);
  expect(links[0].textContent).toContain("Plan.md");
  expect(links[0].textContent).toContain("Ideas · ");
  expect(links[1].textContent).toContain("Next week.md");
  expect(links[1].textContent).toContain("Ideas/Deep · ");
  expect(links[2].textContent).toBe(
    `Filler 9.md${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(Date.UTC(2026, 10, 11, 9, 11)))}`,
  );
  expect(within(recent).queryByText("Old.md")).toBeNull();
  expect(links[0].querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-11-11T09:30:00.000Z",
  );

  fireEvent.click(links[1]);
  expect(memory.history[memory.history.length - 1]).toBe(
    "/notes/Ideas/Deep/Next%20week.md",
  );
});

test("recentNotes sorts by change time, keeps path order for the same time, and stops at the count", () => {
  const same = Date.UTC(2026, 10, 11);
  const notes = [
    { ...note("b.md", 0), modifiedMs: same },
    { ...note("a.md", 0), modifiedMs: same },
    note("new.md", 5),
  ];
  expect(recentNotes(notes).map((each) => each.path)).toEqual([
    "new.md",
    "a.md",
    "b.md",
  ]);
  expect(recentNotes(notes, 2).map((each) => each.path)).toEqual([
    "new.md",
    "a.md",
  ]);
  // The list it was given stays as it was.
  expect(notes.map((each) => each.path)).toEqual(["b.md", "a.md", "new.md"]);
});

test("recent notes says when the project has no notes", async () => {
  listNotesMock.mockResolvedValue(ready([]));
  renderDashboard();
  expect(
    await within(widget("Recent notes")).findByText(
      "This project has no notes yet.",
    ),
  ).toBeDefined();
});

test("without an open project, recent notes leads to the projects", async () => {
  listNotesMock.mockResolvedValue({ state: "noProject" });
  const memory = renderDashboard();
  const recent = widget("Recent notes");
  expect(
    await within(recent).findByText(
      "No project is open. Open one to see its notes here.",
    ),
  ).toBeDefined();
  fireEvent.click(
    within(recent).getByRole("button", { name: "Go to Projects" }),
  );
  expect(memory.history[memory.history.length - 1]).toBe("/projects");
});

test("a failed load shows the widget's own error, and Try again loads again", async () => {
  listNotesMock.mockRejectedValueOnce(
    new CommandFailure("list_notes", { kind: "locked" }),
  );
  listNotesMock.mockResolvedValueOnce(ready([note("Plan.md", 1)]));
  renderDashboard();
  const recent = widget("Recent notes");
  const alert = await within(recent).findByRole("alert");
  expect(alert.textContent).toContain(
    "Notes could not be listed. Another program is using this data. Close it and try again.",
  );

  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(within(recent).getByRole("status").textContent).toBe("Loading notes…");
  await within(recent).findByRole("link", { name: /Plan\.md/ });
  expect(within(recent).queryByRole("alert")).toBeNull();
  expect(listNotesMock).toHaveBeenCalledTimes(2);
});

test("an unexpected failure says only that something went wrong, never its text", async () => {
  listNotesMock.mockRejectedValue(new Error("secret note text"));
  renderDashboard();
  const alert = await within(widget("Recent notes")).findByRole("alert");
  expect(alert.textContent).toContain("Notes could not be listed.");
  expect(alert.textContent).not.toContain("secret note text");
});

let broken = true;

function Throwing(): ReactNode {
  if (broken) {
    throw new Error("secret note text");
  }
  return <p>Fixed now</p>;
}

function Loading() {
  const { data, reload } = useWidgetData(
    () => new Promise<string>(() => undefined),
  );
  return (
    <WidgetContent
      data={data}
      loading="Loading other…"
      failed="Other failed."
      onRetry={reload}
    >
      {(value) => <p>{value}</p>}
    </WidgetContent>
  );
}

test("a widget that throws shows its own error; the page and the other widgets keep working", async () => {
  // React reports the caught error; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  broken = true;
  listNotesMock.mockResolvedValue(ready([note("Plan.md", 1)]));
  renderDashboard([
    { id: "broken", title: "Broken", size: "wide", Body: Throwing },
    dashboardWidgets[0],
    { id: "other", title: "Other", size: "normal", Body: Loading },
  ]);

  const failed = widget("Broken");
  expect(failed.getAttribute("data-size")).toBe("wide");
  const alert = within(failed).getByRole("alert");
  expect(alert.textContent).toContain(
    "This widget could not be shown. The other widgets still work.",
  );
  expect(alert.textContent).not.toContain("secret note text");
  expect(
    screen.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeDefined();
  await within(widget("Recent notes")).findByRole("link", {
    name: /Plan\.md/,
  });
  expect(within(widget("Other")).getByRole("status").textContent).toBe(
    "Loading other…",
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);

  // Try again draws the widget fresh.
  broken = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(within(failed).getByText("Fixed now")).toBeDefined();
  expect(within(failed).queryByRole("alert")).toBeNull();
});

test("a change outside Liurium loads the widgets again, keeping the old list meanwhile", async () => {
  let report: (count: number) => void = () => undefined;
  waitMock
    .mockReturnValueOnce(
      new Promise((resolve) => {
        report = resolve;
      }),
    )
    .mockReturnValue(new Promise(() => undefined));
  let answer: (view: NotesView) => void = () => undefined;
  listNotesMock
    .mockResolvedValueOnce(ready([note("Plan.md", 1)]))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
  renderDashboard();
  const recent = widget("Recent notes");
  await within(recent).findByRole("link", { name: /Plan\.md/ });

  await act(async () => {
    report(1);
    await Promise.resolve();
  });
  expect(listNotesMock).toHaveBeenCalledTimes(2);
  // While the new list loads, the old one stays.
  expect(within(recent).queryByRole("status")).toBeNull();
  expect(within(recent).getByRole("link", { name: /Plan\.md/ })).toBeDefined();

  await act(async () => {
    answer(ready([note("Plan.md", 1), note("Outside.md", 9)]));
    await Promise.resolve();
  });
  const links = within(recent).getAllByRole("link");
  expect(links[0].textContent).toContain("Outside.md");
});
