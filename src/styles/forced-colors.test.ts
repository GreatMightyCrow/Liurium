import { expect, test } from "vitest";

const stylesheets = import.meta.glob<string>("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const stateSelector =
  /\.[\w-]+\[(?:aria|data)-(?:current|selected|checked|pressed|highlighted)\b[^\]]*\]/g;

function forcedColorsBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(
    /@media\s*\(forced-colors:\s*active\)\s*\{/g,
  )) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < css.length) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    }
    blocks.push(css.slice(match.index, end));
  }
  return blocks;
}

// Windows contrast themes (forced colors) drop backgrounds and shadows, so a
// state shown only that way disappears (found in M1-008: the current sidebar
// item and the highlighted menu item). Each such state needs its own rule
// inside `@media (forced-colors: active)`.
test.each(Object.entries(stylesheets))(
  "%s keeps background-only states visible in forced colors",
  (_path, css) => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = forcedColorsBlocks(withoutComments);
    const forced = blocks.join("\n");
    let normal = withoutComments;
    for (const block of blocks) {
      normal = normal.replace(block, "");
    }

    const missing: string[] = [];
    for (const [, selectors, body] of normal.matchAll(
      /([^{}]+)\{([^{}]*)\}/g,
    )) {
      if (!/\b(?:background|box-shadow)\s*:/.test(body)) continue;
      for (const [selector] of selectors.matchAll(stateSelector)) {
        if (!forced.includes(selector)) missing.push(selector);
      }
    }
    expect(missing).toEqual([]);
  },
);

// In forced colors the browser draws a Canvas-colored backplate behind text.
// On a selection background the text then vanishes (found in M1-008), unless
// the rule turns forced-color-adjust off and sets its system colors itself.
test.each(Object.entries(stylesheets))(
  "%s turns the text backplate off where forced colors set a background",
  (_path, css) => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const withBackplate: string[] = [];
    for (const block of forcedColorsBlocks(withoutComments)) {
      for (const [, selectors, body] of block.matchAll(
        /([^{}]+)\{([^{}]*)\}/g,
      )) {
        if (
          /\bbackground\s*:/.test(body) &&
          !/forced-color-adjust\s*:\s*none/.test(body)
        ) {
          withBackplate.push(selectors.trim());
        }
      }
    }
    expect(withBackplate).toEqual([]);
  },
);
