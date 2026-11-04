import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { onNotes, useLayoutChoice, useSidebarCollapsed } from "./layoutChoice";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

test("a choice starts at its default and is remembered", () => {
  const first = renderHook(() => useLayoutChoice("liurium.test", false));
  expect(first.result.current[0]).toBe(false);
  act(() => {
    first.result.current[1](true);
  });
  expect(first.result.current[0]).toBe(true);

  const again = renderHook(() => useLayoutChoice("liurium.test", false));
  expect(again.result.current[0]).toBe(true);
});

test("without storage the default applies and choices still work", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result } = renderHook(() => useLayoutChoice("liurium.test", true));
  expect(result.current[0]).toBe(true);
  act(() => {
    result.current[1](false);
  });
  expect(result.current[0]).toBe(false);
});

test("the sidebar starts collapsed on Notes only", () => {
  expect(onNotes("/notes")).toBe(true);
  expect(onNotes("/notes/Ideas/Plan.md")).toBe(true);
  expect(onNotes("/notes-old")).toBe(false);
  expect(
    renderHook(() => useSidebarCollapsed("/notes/a.md")).result.current[0],
  ).toBe(true);
  expect(
    renderHook(() => useSidebarCollapsed("/projects")).result.current[0],
  ).toBe(false);
});
