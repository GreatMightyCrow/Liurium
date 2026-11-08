import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Router } from "wouter";
import { navigate, useHashLocation } from "wouter/use-hash-location";
import { AppRoutes } from "./AppRoutes";

// The Tasks page breaks while rendering; the Dashboard shows its title.
vi.mock("./TasksPage", () => ({
  TasksPage: function BrokenPage(): never {
    throw new Error("broken tasks page");
  },
}));
vi.mock("./PlaceholderPage", () => ({
  PlaceholderPage: function FakePage({ title }: { title: string }) {
    return <h1>{title}</h1>;
  },
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("a page that fails to render leaves the other pages working", () => {
  // React reports the caught error; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <Router hook={useHashLocation}>
      <AppRoutes />
    </Router>,
  );
  act(() => {
    navigate("/tasks");
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "This page could not be shown",
  );

  act(() => {
    navigate("/");
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeDefined();
});
