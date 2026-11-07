import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

function write(folder: string, name: string, text: string) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), text);
}

async function openNote(page: Page, name = "Plan.md") {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Notes" })
    .click();
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name })
    .click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

/** Everything the page says to its console, so a test can look through it. */
function consoleOf(page: Page): string[] {
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  return said;
}

const blocked = (said: readonly string[]) =>
  said.filter((text) => text.includes("Content Security Policy"));

/** The module files with KaTeX in their name that this page loaded. */
const katexScripts = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /katex[^/]*\.js/i.test(name)),
  );

const content = (page: Page) => page.locator(".cm-content");
const formulas = (page: Page) => page.locator(".cm-content .cm-math");

test("a formula shows with KaTeX's fonts, its source returns at the cursor, the file stays", async ({
  app,
}) => {
  const folder = app.folder("Math-");
  const before =
    "before\r\n\r\n$a*b*c^2 + \\frac{1}{x}$ holds\r\n\r\nafter\r\n";
  write(folder, "Plan.md", before);
  const page = await app.launch({ pick: folder });
  const said = consoleOf(page);
  await openNote(page);

  const formula = formulas(page).first();
  await expect(formula.locator(".katex-html")).toBeVisible();
  await expect(formula.locator("math")).toHaveCount(1);
  await expect(formula.locator("annotation")).toHaveText(
    "a*b*c^2 + \\frac{1}{x}",
  );

  // A real font, not a fallback: every one of them loads under the CSP.
  const fonts = await page.evaluate(async () => {
    const faces = [...document.fonts].filter((face) =>
      face.family.includes("KaTeX"),
    );
    await Promise.all(faces.map((face) => face.load()));
    return faces.map((face) => face.status);
  });
  // The other side of the last test here: KaTeX's module shows up in this list.
  expect(await katexScripts(page)).not.toEqual([]);
  expect(fonts).toHaveLength(20);
  expect(new Set(fonts)).toEqual(new Set(["loaded"]));
  expect(
    await formula
      .locator(".mathnormal")
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("KaTeX_Math");

  // At the cursor the source reads as written: Lezer's emphasis stays out of it.
  await content(page).getByText("before").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(content(page)).toContainText("$a*b*c^2 + \\frac{1}{x}$");
  await expect(formulas(page)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(formulas(page)).toHaveCount(1);

  // A click on it does the same, once the mouse is up.
  await formulas(page).click();
  await expect(formulas(page)).toHaveCount(0);
  await expect(content(page)).toContainText("\\frac");

  // Typing elsewhere keeps the same element, so nothing is drawn again.
  await content(page).getByText("after").click();
  await formulas(page).evaluate((element: HTMLElement) => {
    element.dataset.mark = "kept";
  });
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(content(page)).toContainText("after!");
  await expect(page.locator('.cm-math[data-mark="kept"]')).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe(before);

  // The source view shows only text.
  await page.getByRole("button", { name: "Show source" }).click();
  await expect(formulas(page)).toHaveCount(0);
  await expect(content(page)).toContainText("\\frac");

  expect(blocked(said)).toEqual([]);
});

test("a formula over several lines is a block the arrow keys go into", async ({
  app,
}) => {
  const folder = app.folder("Math-");
  const before = "above\n\n$$\nx^2 +\ny^2\n$$\n\nbelow\n";
  write(folder, "Plan.md", before);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const block = page.locator(".cm-content .cm-math-block");
  await expect(block.locator(".katex-display")).toBeVisible();
  await expect(block.locator("annotation")).toHaveText(/x\^2 \+\s+y\^2/);

  // Down from above: its source at its first line.
  await content(page).getByText("above").click();
  await page.keyboard.press("ArrowDown");
  await expect(block).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(content(page)).toContainText("x^2 +");
  await expect(block).toHaveCount(0);

  // Through it, line by line, and out at the bottom.
  for (let line = 0; line < 4; line += 1) {
    await expect(block).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
  }
  await expect(block).toBeVisible();

  // Up from below: its source at its last line.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(block).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(block).toHaveCount(0);
  await expect(content(page)).toContainText("y^2");

  // Editing there is plain text, and saved as such.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.type("z + ");
  await content(page).getByText("below").click();
  await expect(block.locator(".katex-display")).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe("above\n\n$$\nx^2 +\nz + y^2\n$$\n\nbelow\n");

  // A click on it shows the source too.
  await block.click();
  await expect(block).toHaveCount(0);
});

test("a formula in a table cell shows, and its source is edited in the cell", async ({
  app,
}) => {
  const folder = app.folder("Math-");
  const before =
    "| Name | Value |\n| --- | --- |\n| one | $x\\|y^2$ |\n\nafter\n";
  write(folder, "Plan.md", before);
  const page = await app.launch({ pick: folder });
  const said = consoleOf(page);
  await openNote(page);

  const cell = page.locator(".cm-table td").nth(1);
  await expect(cell.locator(".katex-html")).toBeVisible();
  await expect(cell.locator("annotation")).toHaveText("x|y^2");

  await cell.click();
  await expect(page.locator(".cm-cell-input")).toHaveValue("$x|y^2$");
  await page.keyboard.press("Escape");
  await expect(cell.locator(".katex-html")).toBeVisible();

  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe(before);
  expect(blocked(said)).toEqual([]);
});

test("what a formula may not do it does not do", async ({ app }) => {
  const folder = app.folder("Math-");
  const SECRET = "secret-of-this-note";
  write(
    folder,
    "Plan.md",
    [
      "a $\\notACommand$ b",
      "",
      `c $\\message{${SECRET}}x$ d`,
      "",
      `e $\\errmessage{${SECRET}}y$ f`,
      "",
      "g $\\href{https://example.org}{z}$ h",
      "",
      "i $\\includegraphics{pic.png}$ j",
      "",
      "k $\\raisebox{50em}{w}$ l",
      "",
      "m $\\htmlStyle{position: fixed}{v}$ n",
      "",
    ].join("\n"),
  );
  const page = await app.launch({ pick: folder });
  const said = consoleOf(page);
  await openNote(page);

  const refused = page.locator(".cm-content .cm-math-error").first();
  await expect(refused).toHaveText("\\notACommand");
  expect(await refused.getAttribute("title")).toMatch(/^Formula not shown: /);
  await expect(formulas(page)).toHaveCount(7);
  await expect(
    page.locator(".cm-content .cm-math a, .cm-content .cm-math img"),
  ).toHaveCount(0);

  // What leaves its box is clipped, so it cannot lie over other parts of the window.
  const raised = formulas(page).nth(5);
  expect(
    await raised.evaluate((element) => getComputedStyle(element).contain),
  ).toContain("paint");

  expect(said.filter((text) => text.includes(SECRET))).toEqual([]);
  expect(blocked(said)).toEqual([]);
});

test("definitions reach the formulas below, and \\ce works", async ({
  app,
}) => {
  const folder = app.folder("Math-");
  write(
    folder,
    "Plan.md",
    [
      "first $\\RR$ here",
      "",
      "$$\\def\\RR{\\mathbb{R}}$$",
      "",
      "then $\\RR$ here",
      "",
      "water $\\ce{H2O}$ here",
      "",
    ].join("\n"),
  );
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await expect(formulas(page)).toHaveCount(4);
  // Above the definition it does not hold, below it does.
  await expect(formulas(page).nth(0)).toHaveClass(/cm-math-error/);
  await expect(formulas(page).nth(2).locator(".katex-html")).toBeVisible();
  await expect(formulas(page).nth(3).locator(".katex-html")).toBeVisible();

  // Changing it redraws the formula below it.
  await formulas(page).nth(1).click();
  await expect(content(page)).toContainText("\\mathbb");
  await page.keyboard.press("End");
  for (let key = 0; key < "\\def\\RR{\\mathbb{R}}$$".length; key += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.press("Delete");
  await page.keyboard.type("!");
  await content(page).getByText("first").click();
  await expect(formulas(page).nth(2)).toHaveClass(/cm-math-error/);
});

test("a note without a formula does not load KaTeX", async ({ app }) => {
  const folder = app.folder("Math-");
  write(folder, "Plan.md", "just $5 and $6 today\n");
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(content(page)).toContainText("just $5 and $6 today");
  expect(await katexScripts(page)).toEqual([]);
  await expect(formulas(page)).toHaveCount(0);
});
