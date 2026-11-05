import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { checkNoteChanges, waitNoteChanges } from "../../lib/ipc/commands";
import { useNoteChanges } from "./useNoteChanges";

vi.mock("../../lib/ipc/commands", () => ({
  waitNoteChanges: vi.fn(),
  checkNoteChanges: vi.fn(),
}));

const waitMock = vi.mocked(waitNoteChanges);
const checkMock = vi.mocked(checkNoteChanges);

/** Each wait stays open until the test answers it. */
let answers: ((count: number) => void)[] = [];
let failures: ((reason: unknown) => void)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  answers = [];
  failures = [];
  waitMock.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        answers.push(resolve);
        failures.push(reject);
      }),
  );
  checkMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test("a new count calls back and waits again with it; the same count only waits again", async () => {
  const onChange = vi.fn();
  renderHook(() => {
    useNoteChanges(onChange);
  });
  expect(waitMock).toHaveBeenLastCalledWith(0);

  // Thirty seconds passed without a change.
  answers[0]?.(0);
  await waitFor(() => {
    expect(waitMock).toHaveBeenCalledTimes(2);
  });
  expect(onChange).not.toHaveBeenCalled();

  answers[1]?.(3);
  await waitFor(() => {
    expect(waitMock).toHaveBeenCalledTimes(3);
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(waitMock).toHaveBeenLastCalledWith(3);
});

test("the window getting focus makes Rust look", () => {
  renderHook(() => {
    useNoteChanges(vi.fn());
  });
  expect(checkMock).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("focus"));

  expect(checkMock).toHaveBeenCalledTimes(1);
});

test("a failed wait tries again later", async () => {
  vi.useFakeTimers();
  renderHook(() => {
    useNoteChanges(vi.fn());
  });

  failures[0]?.(new Error("no"));
  await vi.advanceTimersByTimeAsync(4999);
  expect(waitMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(waitMock).toHaveBeenCalledTimes(2);
});

test("after leaving the page nothing is called back or looked at", async () => {
  const onChange = vi.fn();
  const { unmount } = renderHook(() => {
    useNoteChanges(onChange);
  });

  unmount();
  answers[0]?.(1);
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();

  expect(onChange).not.toHaveBeenCalled();
  expect(checkMock).not.toHaveBeenCalled();
  expect(waitMock).toHaveBeenCalledTimes(1);
});
