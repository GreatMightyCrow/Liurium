import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import App from "./App";
import { areas } from "./app/areas";

// Routes live in the URL fragment; start every test without one.
beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

function currentPageTitle(): string | null {
  return screen.getByRole("heading", { level: 1 }).textContent;
}

function sidebarLink(label: string): HTMLElement {
  const navigation = screen.getByRole("navigation", { name: "Primary" });
  const link = Array.from(navigation.querySelectorAll("a")).find(
    (anchor) => anchor.textContent === label,
  );
  if (link === undefined) {
    throw new Error(`no sidebar link named ${label}`);
  }
  return link;
}

test("opens the dashboard first and marks it as the current page", () => {
  render(<App />);
  expect(currentPageTitle()).toBe("Dashboard");
  expect(sidebarLink("Dashboard").getAttribute("aria-current")).toBe("page");
});

test.each(areas.map((area) => [area.label]))(
  "reaches %s from the sidebar",
  (label) => {
    render(<App />);
    fireEvent.click(sidebarLink(label));
    expect(currentPageTitle()).toBe(label);
    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual([label]);
  },
);

test("sidebar links are named by their label only, icons stay hidden", () => {
  render(<App />);
  for (const area of areas) {
    expect(screen.getByRole("link", { name: area.label })).toBeDefined();
  }
});

test("choosing the current page again adds no history entry", () => {
  render(<App />);
  fireEvent.click(sidebarLink("Projects"));
  const entries = window.history.length;
  fireEvent.click(sidebarLink("Projects"));
  expect(window.history.length).toBe(entries);
  expect(currentPageTitle()).toBe("Projects");
});

test("an unknown path leads to the dashboard", () => {
  window.history.replaceState(null, "", "/#/nowhere");
  render(<App />);
  expect(currentPageTitle()).toBe("Dashboard");
  expect(window.location.hash).toBe("#/");
});
