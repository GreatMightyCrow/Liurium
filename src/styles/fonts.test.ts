import { expect, test } from "vitest";
import monoFontCss from "@fontsource-variable/atkinson-hyperlegible-mono/wght.css?raw";
import uiFontCss from "@fontsource-variable/atkinson-hyperlegible-next/wght.css?raw";
import indexCss from "./index.css?raw";
import tokensCss from "./tokens.css?raw";

// The browser silently falls back to a system font when a family name does not
// match its @font-face exactly, so compare the names instead of trusting them.
function declaredFamily(fontCss: string): string {
  const family = /font-family:\s*'([^']+)'/.exec(fontCss)?.[1];
  if (family === undefined) {
    throw new Error("font package declares no font-family");
  }
  return family;
}

function firstFamily(token: string): string {
  const family = new RegExp(`${token}:\\s*"([^"]+)"`).exec(tokensCss)?.[1];
  if (family === undefined) {
    throw new Error(
      `${token} does not start with a quoted family in tokens.css`,
    );
  }
  return family;
}

test.each([
  ["--font-ui", "@fontsource-variable/atkinson-hyperlegible-next", uiFontCss],
  [
    "--font-mono",
    "@fontsource-variable/atkinson-hyperlegible-mono",
    monoFontCss,
  ],
])("%s names the bundled font from %s first", (token, fontPackage, fontCss) => {
  expect(indexCss).toContain(`@import "${fontPackage}/wght.css";`);
  expect(firstFamily(token)).toBe(declaredFamily(fontCss));
});
