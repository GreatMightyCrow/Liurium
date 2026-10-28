import { describe, expect, test } from "vitest";
import { themes } from "../app/theme";
import tokensCss from "./tokens.css?raw";

// Themes are an accent plus a base (ADR-0015). `:root` holds the default, orange on
// warm; `:root[data-base="…"]` and `:root[data-accent="…"]` each replace one group.
const baseTokens = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-elevated",
  "--color-border",
  "--color-border-control",
  "--color-text",
  "--color-text-secondary",
  "--color-on-accent",
];
const accentTokens = [
  "--color-accent",
  "--color-accent-hover",
  "--color-accent-muted",
];

interface Block {
  group: "accent" | "base" | undefined;
  name: string | undefined;
  body: string;
}

const blocks: Block[] = Array.from(
  tokensCss.matchAll(
    /:root(?:\[data-(accent|base)="([a-z]+)"\])?\s*\{([^}]*)\}/g,
  ),
  (match) => ({
    group: match[1] as Block["group"],
    name: match[2],
    body: match[3],
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

function block(group: "accent" | "base", name: string): Block {
  const found = blocks.find((b) => b.group === group && b.name === name);
  if (found === undefined) {
    throw new Error(`tokens.css has no :root[data-${group}="${name}"] block`);
  }
  return found;
}

const defaults = new Map(
  blocks
    .filter((b) => b.group === undefined)
    .flatMap((b) => Array.from(hexColors(b.body))),
);

function resolve(accent: string, base: string): Map<string, string> {
  const colors = new Map(defaults);
  if (base !== "warm") {
    for (const [name, value] of hexColors(block("base", base).body)) {
      colors.set(name, value);
    }
  }
  if (accent !== "orange") {
    for (const [name, value] of hexColors(block("accent", accent).body)) {
      colors.set(name, value);
    }
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
  test("the default defines both groups", () => {
    for (const name of [...baseTokens, ...accentTokens]) {
      expect(defaults.has(name), name).toBe(true);
    }
  });

  // A block that sets only part of its group would mix with the default's values.
  test.each([
    ["base", "cool", baseTokens],
    ["base", "graphite", baseTokens],
    ["accent", "mint", accentTokens],
  ] as const)("%s %s replaces exactly its group", (group, name, tokens) => {
    expect([...hexColors(block(group, name).body).keys()].sort()).toEqual(
      [...tokens].sort(),
    );
  });

  // The backdrop is not a hex value, so the contrast tests cannot see it.
  test.each(["warm", "cool", "graphite"])(
    "the %s backdrop is its canvas at 70 %%",
    (base) => {
      const body =
        base === "warm"
          ? blocks.find((b) => b.group === undefined)?.body
          : block("base", base).body;
      const canvas = hexColors(body ?? "").get("--color-canvas") ?? "";
      const rgb = [1, 3, 5].map((start) =>
        parseInt(canvas.slice(start, start + 2), 16),
      );
      expect(body).toContain(`--color-backdrop: rgb(${rgb.join(" ")} / 0.7);`);
    },
  );
});

describe.each(themes)("token contrast %s on %s (WCAG AA)", (accent, base) => {
  const colors = resolve(accent, base);

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
        "--color-accent",
        "--color-accent-hover",
        "--color-success",
        "--color-warning",
        "--color-danger",
      ],
      [...surfaces, "--color-accent-muted"],
    ),
  )("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(
    pairs(["--color-on-accent"], ["--color-accent", "--color-accent-hover"]),
  )("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(pairs(["--color-border-control", "--color-accent"], surfaces))(
    "control indicator %s on %s reaches 3:1",
    (fg, bg) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
    },
  );
});
