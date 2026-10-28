import { expect, test } from "vitest";
import {
  applyTheme,
  appIconFor,
  defaultTheme,
  themeFrom,
  themes,
} from "./theme";

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

test("the title row icon follows the accent", () => {
  expect(appIconFor({ accent: "orange", base: "graphite" })).toBe(
    "/favicon.ico",
  );
  expect(appIconFor({ accent: "mint", base: "cool" })).toBe(
    "/favicon-mint.ico",
  );
});
