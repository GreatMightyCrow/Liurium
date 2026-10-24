import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as windowIpc from "../lib/ipc/window";
import { useWindowControls } from "./useWindowControls";

vi.mock("../lib/ipc/window", () => ({
  minimizeWindow: vi.fn(() => Promise.resolve()),
  toggleMaximizeWindow: vi.fn(() => Promise.resolve()),
  closeWindow: vi.fn(() => Promise.resolve()),
  isWindowMaximized: vi.fn(() => Promise.resolve(false)),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test("reads the maximized state on mount and after every resize", async () => {
  const isMaximized = vi.mocked(windowIpc.isWindowMaximized);
  const { result } = renderHook(() => useWindowControls());
  await waitFor(() => {
    expect(isMaximized).toHaveBeenCalledOnce();
  });
  expect(result.current.maximized).toBe(false);

  isMaximized.mockResolvedValueOnce(true);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(() => {
    expect(result.current.maximized).toBe(true);
  });
});

test("forwards the button actions to the window API", () => {
  const { result } = renderHook(() => useWindowControls());
  result.current.minimize();
  result.current.toggleMaximize();
  result.current.close();
  expect(windowIpc.minimizeWindow).toHaveBeenCalledOnce();
  expect(windowIpc.toggleMaximizeWindow).toHaveBeenCalledOnce();
  expect(windowIpc.closeWindow).toHaveBeenCalledOnce();
});
