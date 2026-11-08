import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type SearchResults, searchNotes } from "../../lib/ipc/commands";
import { CommandFailure } from "../../lib/ipc/errors";
import { axeViolations } from "../../test/axe";
import { SEARCH_DELAY_MS, SearchPanel } from "./SearchPanel";

vi.mock("../../lib/ipc/commands", () => ({
  searchNotes: vi.fn(),
}));

const searchMock = vi.mocked(searchNotes);

const FOUND: SearchResults = {
  notes: [
    {
      path: "Ideas/Garden.md",
      excerpt: {
        offset: 14,
        line: "We plant the tomatoes early.",
        from: 13,
        to: 21,
      },
    },
    { path: "Tomatoes.md", excerpt: null },
  ],
  projects: [
    { id: "open-id", name: "Garden", open: true },
    { id: "other-id", name: "Tomato farm", open: false },
  ],
  shortWords: false,
};

const onOpen = vi.fn();
const onOpenProject = vi.fn();

function Panel({ focusKey = 0 }: { focusKey?: number }) {
  const [query, setQuery] = useState("");
  return (
    <SearchPanel
      query={query}
      onQuery={setQuery}
      focusKey={focusKey}
      refresh={0}
      onOpen={onOpen}
      onOpenProject={onOpenProject}
    />
  );
}

/** The result buttons, without the clear button. */
function hits(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("data-result"));
}

function field(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: "Search notes" });
}

async function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchMock.mockReset();
  searchMock.mockResolvedValue(FOUND);
  onOpen.mockReset();
  onOpenProject.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("an empty field asks nothing and says what to do", async () => {
  render(<Panel />);
  await type("   ");

  expect(searchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe(
    "Type to search the notes of this project.",
  );
});

test("typing asks once after a pause, with the query trimmed", async () => {
  render(<Panel />);
  fireEvent.change(field(), { target: { value: "to" } });
  fireEvent.change(field(), { target: { value: "tomato " } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1);
  });
  expect(searchMock).not.toHaveBeenCalled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });

  expect(searchMock).toHaveBeenCalledTimes(1);
  expect(searchMock).toHaveBeenCalledWith("tomato");
});

test("results show the note, its folder, and the matching line with the match marked", async () => {
  render(<Panel />);
  await type("tomato");

  expect(screen.getByRole("status").textContent).toBe(
    "2 notes, 1 other project",
  );
  const first = hits()[0];
  expect(first.textContent).toBe("Garden.mdIdeasWe plant the tomatoes early.");
  expect(first.querySelector("mark")?.textContent).toBe("tomatoes");
  // The open project is where the notes come from, so it is not listed again.
  expect(hits().map((button) => button.textContent)).not.toContain(
    "GardenOpen this project",
  );
});

test("a result opens its note at the match, or at the start without one", async () => {
  render(<Panel />);
  await type("tomato");

  fireEvent.click(hits()[0]);
  fireEvent.click(hits()[1]);

  expect(onOpen.mock.calls).toEqual([
    ["Ideas/Garden.md", 14],
    ["Tomatoes.md", null],
  ]);
});

test("another project opens from its result", async () => {
  render(<Panel />);
  await type("tomato");

  fireEvent.click(screen.getByRole("button", { name: /Tomato farm/ }));

  expect(onOpenProject).toHaveBeenCalledWith("other-id");
});

test("Enter opens the first note; arrow keys move through results and back", async () => {
  render(<Panel />);
  await type("tomato");
  const buttons = hits();

  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[0]);
  fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1], { key: "ArrowUp" });
  fireEvent.keyDown(buttons[0], { key: "ArrowUp" });
  expect(document.activeElement).toBe(field());

  fireEvent.keyDown(field(), { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("Ideas/Garden.md", 14);
});

test("Escape empties the field", async () => {
  render(<Panel />);
  await type("tomato");

  fireEvent.keyDown(field(), { key: "Escape" });

  expect(field().value).toBe("");
  expect(screen.queryAllByRole("button")).toEqual([]);
});

test("short words are explained", async () => {
  searchMock.mockResolvedValue({ ...FOUND, shortWords: true });
  render(<Panel />);
  await type("to");

  expect(
    screen.getByText("Words shorter than three letters only match note names."),
  ).toBeDefined();
});

test("nothing found and a failure are said in words", async () => {
  searchMock.mockResolvedValue({ notes: [], projects: [], shortWords: false });
  render(<Panel />);
  await type("nothing");
  expect(screen.getByRole("status").textContent).toBe("No notes match");

  searchMock.mockRejectedValue(
    new CommandFailure("search_notes", { kind: "noProject" }),
  );
  await type("other");
  expect(screen.getByRole("status").textContent).toMatch(/^Search failed\. /);
});

test("an answer to an older query never replaces a newer one", async () => {
  let answerOld: (results: SearchResults) => void = () => undefined;
  searchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerOld = resolve;
      }),
  );
  render(<Panel />);
  await type("old");
  await type("tomato");

  await act(async () => {
    answerOld({
      notes: [{ path: "Old.md", excerpt: null }],
      projects: [],
      shortWords: false,
    });
    await Promise.resolve();
  });

  expect(screen.queryByText("Old.md")).toBeNull();
  expect(screen.getByText("Tomatoes.md")).toBeDefined();
});

test("a new focus key puts the cursor into the field", () => {
  const { rerender } = render(<Panel focusKey={0} />);
  field().blur();

  rerender(<Panel focusKey={1} />);

  expect(document.activeElement).toBe(field());
});

test("the panel with results passes axe", async () => {
  vi.useRealTimers();
  render(
    <main>
      <Panel />
    </main>,
  );
  fireEvent.change(field(), { target: { value: "tomato" } });
  await screen.findByText("Tomatoes.md");

  expect(await axeViolations()).toEqual([]);
});

test("the clear button empties the field and keeps the cursor there", async () => {
  render(<Panel />);
  expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  await type("tomato");

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

  expect(field().value).toBe("");
  expect(document.activeElement).toBe(field());
});
