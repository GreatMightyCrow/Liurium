import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import { areas } from "./app/areas";
import { axeViolations } from "./test/axe";

// No Tauri runtime in tests; the Liurium frame asks it whether the window is maximized.
vi.mock("./lib/ipc/window", () => ({
  minimizeWindow: vi.fn(() => Promise.resolve()),
  toggleMaximizeWindow: vi.fn(() => Promise.resolve()),
  closeWindow: vi.fn(() => Promise.resolve()),
  isWindowMaximized: vi.fn(() => Promise.resolve(false)),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// The app as it starts: Liurium frame (the default), so title bar and window buttons are checked too.
async function renderAt(path: string) {
  window.history.replaceState(null, "", `/?frame=liurium#${path}`);
  render(<App />);
  await screen.findByRole("button", { name: "Close" });
}

async function openGallery() {
  await renderAt("/dev/ui");
  await screen.findByRole("heading", { level: 1, name: "UI gallery" });
}

test.each(areas.map((area) => [area.label, area.path]))(
  "the %s page passes axe",
  async (_label, path) => {
    await renderAt(path);
    expect(await axeViolations()).toEqual([]);
  },
);

test("the UI gallery passes axe", async () => {
  await openGallery();
  expect(await axeViolations()).toEqual([]);
});

test("an open dialog passes axe", async () => {
  await openGallery();
  fireEvent.click(screen.getByRole("button", { name: "Rename note…" }));
  await screen.findByRole("dialog", { name: "Rename note" });
  expect(await axeViolations()).toEqual([]);
});

test("an open menu passes axe", async () => {
  await openGallery();
  fireEvent.click(screen.getByRole("button", { name: "Note actions" }));
  await screen.findByRole("menu");
  expect(await axeViolations()).toEqual([]);
});

test("notifications pass axe", async () => {
  await openGallery();
  fireEvent.click(screen.getByRole("button", { name: "Show success" }));
  fireEvent.click(screen.getByRole("button", { name: "Show error" }));
  await screen.findAllByText("Could not save the note");
  expect(await axeViolations()).toEqual([]);
});

test("the page error state passes axe", async () => {
  // React reports the deliberate render error; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await openGallery();
  fireEvent.click(screen.getByRole("button", { name: "Break this page" }));
  await screen.findByText("This page could not be shown");
  expect(await axeViolations()).toEqual([]);
});
