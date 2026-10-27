import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { areas } from "./app/areas";

// No Tauri runtime in tests; the custom frames ask it whether the window is maximized.
vi.mock("./lib/ipc/window", () => ({
  minimizeWindow: vi.fn(() => Promise.resolve()),
  toggleMaximizeWindow: vi.fn(() => Promise.resolve()),
  closeWindow: vi.fn(() => Promise.resolve()),
  isWindowMaximized: vi.fn(() => Promise.resolve(false)),
}));

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

test("choosing a page moves focus to its heading", () => {
  render(<App />);
  fireEvent.click(sidebarLink("Notes"));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { level: 1, name: "Notes" }),
  );
  fireEvent.click(sidebarLink("Settings"));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { level: 1, name: "Settings" }),
  );
});

test("starting the app leaves focus where it is", () => {
  render(<App />);
  expect(document.activeElement).toBe(document.body);
});

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

test("the frame style from the window URL decides about the window buttons", async () => {
  window.history.replaceState(null, "", "/?frame=hidden");
  render(<App />);
  expect(await screen.findByRole("button", { name: "Close" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Minimize" })).toBeDefined();
});

test("the native frame has no window buttons of its own", () => {
  render(<App />);
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

test("an unknown path leads to the dashboard", () => {
  window.history.replaceState(null, "", "/#/nowhere");
  render(<App />);
  expect(currentPageTitle()).toBe("Dashboard");
  expect(window.location.hash).toBe("#/");
});
