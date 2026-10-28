import { describe, expect, test } from "vitest";
import { modes, themes } from "../app/theme";
import tokensCss from "./tokens.css?raw";

// Themes are an accent plus a base, in a dark or light mode (ADR-0015). `:root` holds
// the default, orange on warm in dark; each block below replaces whole groups.
const baseTokens = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-elevated",
  "--color-border",
  "--color-border-control",
  "--color-text",
  "--color-text-secondary",
  "--color-on-accent",
  "--color-on-danger",
];
const accentTokens = [
  "--color-accent",
  "--color-accent-hover",
  "--color-accent-muted",
  "--color-accent-text",
];
const statusTokens = ["--color-success", "--color-warning", "--color-danger"];

interface Block {
  /** The block's attribute selectors, for example `{ mode: "light", base: "cool" }`. */
  attributes: Record<string, string>;
  body: string;
}

const blocks: Block[] = Array.from(
  tokensCss.matchAll(/:root((?:\[data-[a-z]+="[a-z]+"\])*)\s*\{([^}]*)\}/g),
  (match) => ({
    attributes: Object.fromEntries(
      Array.from(match[1].matchAll(/\[data-([a-z]+)="([a-z]+)"\]/g), (m) => [
        m[1],
        m[2],
      ]),
    ),
    body: match[2],
  }),
);

function hexColors(body: string): Map<string, string> {
  return new Map(
    Array.from(
      body.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-f]{6});/gi),
      (match) => [match[1], match[2]],
    ),
  );
}

function block(attributes: Record<string, string>): Block {
  const key = JSON.stringify(attributes);
  const found = blocks.find((b) => JSON.stringify(b.attributes) === key);
  if (found === undefined) {
    throw new Error(`tokens.css has no :root block for ${key}`);
  }
  return found;
}

// Applies the matching blocks like the cascade does: more attributes win, and among
// blocks with the same number of attributes the later one wins.
function resolve(theme: Record<string, string>): Map<string, string> {
  const matching = blocks
    .filter((b) =>
      Object.entries(b.attributes).every(
        ([name, value]) => theme[name] === value,
      ),
    )
    .map((b, order) => ({ b, order }))
    .sort(
      (x, y) =>
        Object.keys(x.b.attributes).length -
          Object.keys(y.b.attributes).length || x.order - y.order,
    );
  const colors = new Map<string, string>();
  for (const { b } of matching) {
    for (const [name, value] of hexColors(b.body)) colors.set(name, value);
  }
  return colors;
}

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pairs(
  foregrounds: string[],
  backgrounds: string[],
): [string, string][] {
  return foregrounds.flatMap((fg) =>
    backgrounds.map((bg): [string, string] => [fg, bg]),
  );
}

const surfaces = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-elevated",
];

describe("theme blocks", () => {
  test("the default defines every color group", () => {
    const defaults = hexColors(block({}).body);
    for (const name of [...baseTokens, ...accentTokens, ...statusTokens]) {
      expect(defaults.has(name), name).toBe(true);
    }
  });

  // A block that sets only part of its group would mix with another block's values.
  test.each([
    [{ base: "cool" }, baseTokens],
    [{ base: "graphite" }, baseTokens],
    [{ accent: "mint" }, accentTokens],
    [{ mode: "light" }, [...baseTokens, ...accentTokens, ...statusTokens]],
    [{ mode: "light", base: "cool" }, baseTokens],
    [{ mode: "light", base: "graphite" }, baseTokens],
    [{ mode: "light", accent: "mint" }, accentTokens],
  ])("%o replaces exactly its groups", (attributes, tokens) => {
    expect([...hexColors(block(attributes).body).keys()].sort()).toEqual(
      [...tokens].sort(),
    );
  });

  // The backdrop is not a hex value, so the contrast tests cannot see it.
  test.each<Record<string, string>>([
    {},
    { base: "cool" },
    { base: "graphite" },
  ])("the dark backdrop of %o is its canvas at 70 %%", (attributes) => {
    const body = block(attributes).body;
    const canvas = hexColors(body).get("--color-canvas") ?? "";
    const rgb = [1, 3, 5].map((start) =>
      parseInt(canvas.slice(start, start + 2), 16),
    );
    expect(body).toContain(`--color-backdrop: rgb(${rgb.join(" ")} / 0.7);`);
  });

  // A white veil would hide where the dialog ends; light dims with black instead.
  test("the light backdrop dims with black for every base", () => {
    expect(block({ mode: "light" }).body).toContain(
      "--color-backdrop: rgb(0 0 0 / 0.32);",
    );
    for (const base of ["cool", "graphite"]) {
      expect(block({ mode: "light", base }).body).not.toContain(
        "--color-backdrop",
      );
    }
  });
});

describe.each(
  modes.flatMap((mode) => themes.map(([accent, base]) => [mode, accent, base])),
)("token contrast %s %s on %s (WCAG AA)", (mode, accent, base) => {
  const colors = resolve({ mode, accent, base });

  function contrast(foreground: string, background: string): number {
    const [lighter, darker] = [foreground, background]
      .map((name) => {
        const value = colors.get(name);
        if (value === undefined) {
          throw new Error(`${name} is not a 6-digit hex color in tokens.css`);
        }
        return luminance(value);
      })
      .sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  }

  test.each(
    pairs(
      [
        "--color-text",
        "--color-text-secondary",
        "--color-accent-text",
        "--color-success",
        "--color-warning",
        "--color-danger",
      ],
      [...surfaces, "--color-accent-muted"],
    ),
  )("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ["--color-on-accent", "--color-accent"],
    ["--color-on-accent", "--color-accent-hover"],
    ["--color-on-danger", "--color-danger"],
  ])("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(pairs(["--color-border-control", "--color-accent-text"], surfaces))(
    "control indicator %s on %s reaches 3:1",
    (fg, bg) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
    },
  );
});
