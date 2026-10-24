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

// Native frame style (ADR-0013): the Windows title bar follows the dark UI.
test("native title bar uses the dark theme", () => {
  // `decorations` defaults to true when the key is absent.
  const frame: { decorations?: boolean; theme: string } = mainWindow;
  expect(frame.decorations ?? true).toBe(true);
  expect(frame.theme).toBe("Dark");
});
