import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

function Broken(): never {
  throw new Error("secret note content must not be shown");
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a page that fails to render shows the error state, not its error text", () => {
  // React and the boundary log the error; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <PageErrorBoundary resetKey="/notes">
      <Broken />
    </PageErrorBoundary>,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("This page could not be shown");
  expect(alert.textContent).not.toContain("secret note content");
  expect(screen.getByRole("button", { name: "Reload Liurium" })).toBeDefined();
});

test("moving to another page clears the error", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { rerender } = render(
    <PageErrorBoundary resetKey="/notes">
      <Broken />
    </PageErrorBoundary>,
  );
  rerender(
    <PageErrorBoundary resetKey="/tasks">
      <p>Tasks page</p>
    </PageErrorBoundary>,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Tasks page")).toBeDefined();
});

test("the reload action reloads the window", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const reload = vi.fn();
  render(
    <PageErrorBoundary resetKey="/notes" onReload={reload}>
      <Broken />
    </PageErrorBoundary>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload Liurium" }));
  expect(reload).toHaveBeenCalledOnce();
});
