import { expect, test } from "vitest";
import packageCss from "katex/dist/katex.css?raw";
import indexCss from "./index.css?raw";
import fontsCss from "./katexFonts.css?raw";

// A formula's characters would silently come from a wrong font if a rule were missing
// or named another file after an update of KaTeX.
function faces(css: string, file: RegExp): string[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
    .map(([, body]) =>
      [
        /font-family:\s*"([^"]+)"/.exec(body)?.[1],
        file.exec(body)?.[1],
        /font-weight:\s*(\w+)/.exec(body)?.[1],
        /font-style:\s*(\w+)/.exec(body)?.[1],
      ].join(" "),
    )
    .sort();
}

test("every font of the KaTeX package is declared, as woff2", () => {
  const declared = faces(packageCss, /url\(fonts\/([^)]+\.woff2)\)/);
  expect(declared).toHaveLength(20);
  expect(
    faces(fontsCss, /url\("katex\/dist\/fonts\/([^"]+\.woff2)"\)/),
  ).toEqual(declared);
});

test("the fonts are part of the page's styles", () => {
  expect(indexCss).toContain('@import "./katexFonts.css";');
});
