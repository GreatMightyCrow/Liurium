import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  answerCloseQuestion,
  type CloseQuestion,
  waitCloseQuestion,
} from "../lib/ipc/commands";
import { axeViolations } from "../test/axe";
import { CloseQuestionDialog } from "./CloseQuestionDialog";

vi.mock("../lib/ipc/commands", () => ({
  waitCloseQuestion: vi.fn(),
  answerCloseQuestion: vi.fn(),
}));

const waitMock = vi.mocked(waitCloseQuestion);
const answerMock = vi.mocked(answerCloseQuestion);

/** Each wait stays open until the test answers it. */
let waits: ((question: CloseQuestion | null) => void)[] = [];

function asked(question: CloseQuestion) {
  act(() => {
    waits[waits.length - 1]?.(question);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  waits = [];
  waitMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        waits.push(resolve);
      }),
  );
  answerMock.mockResolvedValue("stays");
});

const CHANGED: CloseQuestion = { name: "Plan.md", reason: "changedOutside" };

test("nothing shows until Rust asks, and a quiet wait only waits again", async () => {
  render(<CloseQuestionDialog />);
  expect(screen.queryByRole("dialog")).toBeNull();

  await act(async () => {
    waits[0]?.(null);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(waitMock).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(answerMock).not.toHaveBeenCalled();
});

test("the question shows in Liurium's dialog and Rust is told it shows", async () => {
  render(<CloseQuestionDialog />);

  asked(CHANGED);

  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain(
    "Your changes to “Plan.md” are not saved.",
  );
  expect(dialog.textContent).toContain("changed outside Liurium");
  expect(answerMock).toHaveBeenCalledWith("shown");
  expect(
    screen.getByRole("button", { name: "Keep both and close" }),
  ).toBeDefined();
  expect(await axeViolations()).toEqual([]);
});

test("each reason has its own words; a deleted note keeps a copy", async () => {
  render(<CloseQuestionDialog />);

  asked({ name: "Plan.md", reason: "deletedOutside" });
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("deleted or moved outside Liurium");
  expect(
    screen.getByRole("button", { name: "Keep copy and close" }),
  ).toBeDefined();

  asked({ name: "Plan.md", reason: "notWritten" });
  await waitFor(() => {
    expect(screen.getByRole("dialog").textContent).toContain(
      "could not write the file",
    );
  });
});

test("closing again while it shows tells Rust again and keeps one dialog", async () => {
  render(<CloseQuestionDialog />);
  asked(CHANGED);
  await screen.findByRole("dialog");
  await waitFor(() => {
    expect(waitMock).toHaveBeenCalledTimes(2);
  });

  asked({ ...CHANGED });

  await waitFor(() => {
    expect(
      answerMock.mock.calls.filter(([choice]) => choice === "shown"),
    ).toHaveLength(2);
  });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("Cancel and Escape stay in the app", async () => {
  render(<CloseQuestionDialog />);
  asked(CHANGED);
  await screen.findByRole("dialog");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(answerMock).toHaveBeenCalledWith("stay");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("closing without saving and keeping both send their answers", async () => {
  answerMock.mockResolvedValue("closes");
  render(<CloseQuestionDialog />);
  asked(CHANGED);
  await screen.findByRole("dialog");

  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
  await waitFor(() => {
    expect(answerMock).toHaveBeenCalledWith("discard");
  });
  // The window goes away by itself; until then the dialog stays.
  expect(screen.getByRole("dialog")).toBeDefined();

  await waitFor(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Keep both and close",
      }).disabled,
    ).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "Keep both and close" }));
  await waitFor(() => {
    expect(answerMock).toHaveBeenCalledWith("keepBoth");
  });
});

test("a failed copy says so and the window stays", async () => {
  answerMock.mockImplementation((choice) =>
    Promise.resolve(choice === "keepBoth" ? "copyFailed" : "stays"),
  );
  render(<CloseQuestionDialog />);
  asked(CHANGED);
  await screen.findByRole("dialog");

  fireEvent.click(screen.getByRole("button", { name: "Keep both and close" }));

  await screen.findByText(
    "Liurium could not save a copy either. It stays open so nothing is lost.",
  );
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("a failed answer leaves the question open to try again", async () => {
  answerMock.mockImplementation((choice) =>
    choice === "shown"
      ? Promise.resolve("stays")
      : Promise.reject(new Error("no")),
  );
  render(<CloseQuestionDialog />);
  asked(CHANGED);
  await screen.findByRole("dialog");

  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));

  await waitFor(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Discard and close",
      }).disabled,
    ).toBe(false);
  });
  expect(screen.getByRole("dialog")).toBeDefined();
});
