import { expect, test } from "vitest";

// Every stylesheet except tokens.css must use tokens instead of raw values (ADR-0006).
const stylesheets = import.meta.glob<string>(
  ["/src/**/*.css", "!/src/styles/tokens.css"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

const rawValuePatterns: [string, RegExp][] = [
  ["hex color", /#[0-9a-f]{3,8}\b/i],
  ["color function", /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i],
  ["length", /(?<![\w-])\d*\.?\d+(?:px|rem|em|pt|ch|ex|vh|vw|vmin|vmax)\b/i],
  ["duration", /(?<![\w-])\d*\.?\d+m?s\b/i],
];

function findRawValues(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const findings: string[] = [];
  for (const [, property, value] of withoutComments.matchAll(
    /([\w-]+)\s*:\s*([^;{}]+);/g,
  )) {
    for (const [kind, pattern] of rawValuePatterns) {
      if (pattern.test(value)) {
        findings.push(`${property}: ${value.trim()} (${kind})`);
      }
    }
  }
  return findings;
}

// Guards against a silent pass: without the `test.css` setting in
// vite.config.ts, Vitest hands every stylesheet over as an empty string.
test("stylesheets were found and read as text", () => {
  const contents = Object.values(stylesheets);
  expect(contents.length).toBeGreaterThan(0);
  for (const css of contents) {
    expect(typeof css).toBe("string");
    expect(css.trim()).not.toBe("");
  }
});

test.each(Object.entries(stylesheets))(
  "%s uses tokens instead of raw values",
  (_path, css) => {
    expect(findRawValues(css)).toEqual([]);
  },
);
