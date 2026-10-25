import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Router } from "wouter";
import { navigate, useHashLocation } from "wouter/use-hash-location";
import { AppRoutes } from "./AppRoutes";

// The Notes page breaks while rendering; every other page shows its title.
vi.mock("./PlaceholderPage", () => ({
  PlaceholderPage: function FakePage({ title }: { title: string }) {
    if (title === "Notes") {
      throw new Error("broken notes page");
    }
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
    navigate("/notes");
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "This page could not be shown",
  );

  act(() => {
    navigate("/tasks");
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeDefined();
});
