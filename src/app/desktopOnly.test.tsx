import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { blockBrowserBehavior } from "./desktopOnly";

let undo: () => void;

beforeEach(() => {
  undo = blockBrowserBehavior(window);
});

afterEach(() => {
  undo();
});

function page() {
  render(
    <main>
      <p>Some text</p>
      <button type="button">Open</button>
      <input aria-label="Name" />
      <input aria-label="Search" type="search" />
      <input aria-label="Pick" type="checkbox" />
      <textarea aria-label="Notes" />
      <div aria-label="Editor" role="textbox" contentEditable />
    </main>,
  );
}

/** `fireEvent` returns false when a handler prevented the default. */
function rightClick(element: Element): boolean {
  return !fireEvent.contextMenu(element);
}

function press(init: KeyboardEventInit): boolean {
  return !fireEvent.keyDown(document.body, init);
}

test("right-click opens no browser menu outside text fields", () => {
  page();

  expect(rightClick(screen.getByText("Some text"))).toBe(true);
  expect(rightClick(screen.getByRole("button", { name: "Open" }))).toBe(true);
  expect(rightClick(screen.getByRole("checkbox", { name: "Pick" }))).toBe(true);
  expect(rightClick(document.body)).toBe(true);
});

test("text fields keep their menu for cut, copy, and paste", () => {
  page();

  for (const name of ["Name", "Search", "Notes", "Editor"]) {
    expect(rightClick(screen.getByLabelText(name))).toBe(false);
  }
});

test("text inside an editor keeps the menu too", () => {
  render(
    <div aria-label="Editor" contentEditable>
      <p>Line</p>
    </div>,
  );

  expect(rightClick(screen.getByText("Line"))).toBe(false);
});

test.each([
  ["F5", { key: "F5" }],
  ["Ctrl + F5", { key: "F5", ctrlKey: true }],
  ["Ctrl + R", { key: "r", ctrlKey: true }],
  ["Ctrl + Shift + R", { key: "R", ctrlKey: true, shiftKey: true }],
  ["Ctrl + P", { key: "p", ctrlKey: true }],
  ["Ctrl + S", { key: "s", ctrlKey: true }],
  ["Ctrl + F", { key: "f", ctrlKey: true }],
  ["F3", { key: "F3" }],
  ["Ctrl + G", { key: "g", ctrlKey: true }],
  ["Ctrl + O", { key: "o", ctrlKey: true }],
  ["Ctrl + U", { key: "u", ctrlKey: true }],
  ["F7", { key: "F7" }],
])("%s does nothing", (_name, init) => {
  expect(press(init)).toBe(true);
});

test.each([
  ["Ctrl + Plus", { key: "+", ctrlKey: true }],
  ["Ctrl + Minus", { key: "-", ctrlKey: true }],
  ["Ctrl + 0", { key: "0", ctrlKey: true }],
  ["Alt + Left", { key: "ArrowLeft", altKey: true }],
  ["Ctrl + C", { key: "c", ctrlKey: true }],
  ["Ctrl + V", { key: "v", ctrlKey: true }],
  ["F12", { key: "F12" }],
  [
    "AltGr + Q (@ on German keyboards)",
    { key: "q", ctrlKey: true, altKey: true },
  ],
  ["AltGr with R", { key: "r", ctrlKey: true, altKey: true }],
  ["typing r", { key: "r" }],
])("%s keeps working", (_name, init) => {
  expect(press(init)).toBe(false);
});

test("Liurium's own handlers still get a blocked shortcut", () => {
  let seen = false;
  const listener = () => {
    seen = true;
  };
  document.addEventListener("keydown", listener);
  press({ key: "s", ctrlKey: true });
  document.removeEventListener("keydown", listener);

  expect(seen).toBe(true);
});

test("undoing gives the browser its defaults back", () => {
  undo();
  page();

  expect(rightClick(screen.getByText("Some text"))).toBe(false);
  expect(press({ key: "F5" })).toBe(false);
  undo = blockBrowserBehavior(window);
});
