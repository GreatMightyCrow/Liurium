import { expect, test, vi } from "vitest";
import {
  applyTheme,
  appIconFor,
  defaultTheme,
  followMode,
  themeFrom,
  themes,
} from "./theme";

// A stand-in for `matchMedia("(prefers-color-scheme: light)")` that can change.
function colorScheme(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    addEventListener: vi.fn((_: "change", listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_: "change", listener: () => void) => {
      listeners.delete(listener);
    }),
  };
  return {
    query,
    change(toLight: boolean) {
      query.matches = toLight;
      for (const listener of listeners) listener();
    },
  };
}

test.each(themes)("reads accent %s on base %s", (accent, base) => {
  expect(themeFrom(`?frame=liurium&accent=${accent}&base=${base}`)).toEqual({
    accent,
    base,
  });
});

// Rust always passes an allowed pair; anything else must not break the window.
test.each([
  "",
  "?accent=mint",
  "?base=graphite",
  "?accent=orange&base=cool",
  "?accent=mint&base=warm",
  "?accent=MINT&base=cool",
  "?accent=<script>&base=cool",
])("falls back to the default for %j", (search) => {
  expect(themeFrom(search)).toEqual(defaultTheme);
});

test("the default is orange on warm", () => {
  expect(defaultTheme).toEqual({ accent: "orange", base: "warm" });
});

test("applies the theme as data attributes", () => {
  const root = document.createElement("html");
  applyTheme(root, { accent: "mint", base: "graphite" });
  expect(root.dataset.accent).toBe("mint");
  expect(root.dataset.base).toBe("graphite");
});

// Rust sets the window theme; WebView2 reports it as the preferred color scheme.
test.each([
  [false, "dark"],
  [true, "light"],
])("light preferred %s sets mode %s", (light, mode) => {
  const root = document.createElement("html");
  followMode(root, colorScheme(light).query);
  expect(root.dataset.mode).toBe(mode);
});

test("the mode follows a change while running and stops on cleanup", () => {
  const root = document.createElement("html");
  const scheme = colorScheme(false);
  const stop = followMode(root, scheme.query);
  scheme.change(true);
  expect(root.dataset.mode).toBe("light");
  stop();
  scheme.change(false);
  expect(root.dataset.mode).toBe("light");
});

test("the title row icon follows the accent", () => {
  expect(appIconFor({ accent: "orange", base: "graphite" })).toBe(
    "/favicon.ico",
  );
  expect(appIconFor({ accent: "mint", base: "cool" })).toBe(
    "/favicon-mint.ico",
  );
});
