import { expect, test } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import tokensCss from "./tokens.css?raw";

const [mainWindow] = tauriConfig.app.windows;

// Tauri paints the window before any CSS loads, so its background has to be a raw
// value in tauri.conf.json. Keeping it equal to the canvas avoids a flash at startup.
test("window background matches --color-canvas", () => {
  const canvas = /--color-canvas:\s*(#[0-9a-f]{6});/i.exec(tokensCss)?.[1];
  expect(canvas).toBeDefined();
  expect(mainWindow.backgroundColor.toLowerCase()).toBe(canvas?.toLowerCase());
});

// Frame styles (ADR-0013): Rust creates the window and decides the decorations, so
// Tauri must not create it from the config on its own.
test("the main window is created by Rust, with the dark theme for the native frame", () => {
  expect(mainWindow.label).toBe("main");
  expect(mainWindow.create).toBe(false);
  expect(mainWindow.theme).toBe("Dark");
});

// Ctrl + Plus / Minus / 0 enlarge the whole window content (M1-008). On Windows this is
// WebView2's own zoom control and needs no Tauri permission.
test("the main window can be zoomed from the keyboard", () => {
  expect(mainWindow.zoomHotkeysEnabled).toBe(true);
});
