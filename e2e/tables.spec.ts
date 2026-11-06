import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

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

const cell = (page: Page, row: number, column: number) =>
  page.locator(`[data-cell="${String(row)}:${String(column)}"]`);

const input = (page: Page) => page.locator(".cm-cell-input");

test("typing in a cell changes only that cell's bytes, in a CRLF file, and undoes", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  const before =
    "before\r\n\r\n|  Name  | Age |\r\n|:--|--:|\r\n| Ana |   30 |\r\n| **Bo** | 40 |\r\n\r\nafter\r\n";
  writeFileSync(note, before);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const table = page.locator(".cm-content table");
  await expect(table).toBeVisible();
  await expect(cell(page, 2, 0).locator("strong")).toHaveText("Bo");
  await expect(cell(page, 1, 1)).toHaveClass(/cm-align-right/);

  await cell(page, 1, 0).click();
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("Ana");
  await input(page).pressSequentially("-Maria");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe(before.replace("| Ana |", "| Ana-Maria |"));
  await expect(input(page)).toBeFocused();

  // A typed pipe cannot break the row.
  await input(page).pressSequentially("|x");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe(before.replace("| Ana |", "| Ana-Maria\\|x |"));

  // Undo from inside the cell, shown in the field right away.
  await page.keyboard.press("Control+z");
  await expect.poll(() => input(page).inputValue()).not.toBe("Ana-Maria|x");
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Control+z");
  }
  await expect.poll(() => readFileSync(note, "utf8")).toBe(before);
  await expect(input(page)).toHaveValue("Ana");
});

test("Tab, Enter, and the arrow keys move through cells and in and out", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nbelow\n");
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(page.locator(".cm-content table")).toBeVisible();

  // Into the table from the line above, with the arrow key.
  await page.locator(".cm-content").getByText("above").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(input(page)).toHaveValue("a");

  await page.keyboard.press("Tab");
  await expect(input(page)).toHaveValue("b");
  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveValue("2");
  await page.keyboard.press("Shift+Tab");
  await expect(input(page)).toHaveValue("1");

  // Out at the bottom, into the text after the table.
  await page.keyboard.press("ArrowDown");
  await expect(input(page)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("X");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nXbelow\n");

  // Enter in the last row makes a new one.
  await cell(page, 1, 1).click();
  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveValue("");
  await input(page).pressSequentially("new");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n|   | new  |\n\nXbelow\n");

  // Escape goes back to the text.
  await page.keyboard.press("Escape");
  await expect(input(page)).toHaveCount(0);
});

test("the toolbar adds and deletes rows and columns; the header stays", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "| a | b |\n|---|---|\n| 1 | 2 |\n");
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(page.locator(".cm-content table")).toBeVisible();

  await cell(page, 1, 0).click();
  await page.getByRole("button", { name: "Add column" }).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("| a |   | b |\n|---| --- |---|\n| 1 |   | 2 |\n");
  await expect(input(page)).toBeFocused();

  await page.getByRole("button", { name: "Delete column" }).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("| a | b |\n|---|---|\n| 1 | 2 |\n");

  await page.getByRole("button", { name: "Add row" }).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("| a | b |\n|---|---|\n| 1 | 2 |\n|   |   |\n");

  await page.getByRole("button", { name: "Delete row" }).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("| a | b |\n|---|---|\n| 1 | 2 |\n");

  // The header cannot be deleted.
  await cell(page, 0, 0).click();
  await page.getByRole("button", { name: "Delete row" }).click();
  await page.waitForTimeout(300);
  expect(readFileSync(note, "utf8")).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n");
});

test("around a table Backspace cannot break it; Select all with Delete can take it", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  const text = "| a | b |\n|---|---|\n| 1 | 2 |\n\nnext\n";
  writeFileSync(note, text);
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(page.locator(".cm-content table")).toBeVisible();

  // Backspace would pull the next line up, and Markdown reads it as one more row.
  await page.locator(".cm-content").getByText("next").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content table")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(readFileSync(note, "utf8")).toBe(text);

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect.poll(() => readFileSync(note, "utf8")).toBe("");
});

test("after a table that ends the file, the arrow key and a click make a place to type", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "| a | b |\n|---|---|\n| 1 | 2 |");
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(page.locator(".cm-content table")).toBeVisible();
  await page.waitForTimeout(1300);
  // Opening and looking write nothing.
  expect(readFileSync(note, "utf8")).toBe("| a | b |\n|---|---|\n| 1 | 2 |");

  await cell(page, 1, 1).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Y");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("| a | b |\n|---|---|\n| 1 | 2 |\n\nY");
  await expect(cell(page, 1, 1)).toHaveText("2");
  await expect(page.locator("[data-cell]")).toHaveCount(4);

  // And by a click below the table.
  const other = join(folder, "Other.md");
  writeFileSync(other, "| c |\n|---|");
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name: "Other.md" })
    .click();
  await expect(page.locator(".cm-content table")).toBeVisible();
  const box = await page.locator(".cm-editor").boundingBox();
  await page.mouse.click(
    (box?.x ?? 0) + 200,
    (box?.y ?? 0) + (box?.height ?? 0) - 10,
  );
  await page.keyboard.type("Z");
  await expect
    .poll(() => readFileSync(other, "utf8"))
    .toBe("| c |\n|---|\n\nZ");
});

test("a link in a cell follows on a click, and the source view shows the text", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const record = join(app.folder("Record-"), "opened.txt");
  writeFileSync(
    join(folder, "Plan.md"),
    "| a | b |\n|---|---|\n| [docs](https://example.org/d) | plain |\n",
  );
  const page = await app.launch({ pick: folder, openedLinks: record });
  await openNote(page);

  const link = cell(page, 1, 0).locator(".cm-link-external");
  await expect(link).toHaveText("docs");
  await link.click();
  await expect
    .poll(() => readFileSync(record, "utf8").trim())
    .toBe("https://example.org/d");
  await expect(input(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Show source" }).click();
  await expect(page.locator(".cm-content table")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("|---|---|");
  await page.getByRole("button", { name: "Show live preview" }).click();
  await expect(page.locator(".cm-content table")).toBeVisible();
});

test("a callout folds without touching the file", async ({ app }) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  const text =
    "top\n\n> [!warning]- Careful\n> hidden body\n\n> [!note]+ Open one\n> shown body\n\n> [!tip]\n> no title\n\nend\n";
  writeFileSync(note, text);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const content = page.locator(".cm-content");
  await expect(content).toContainText("Careful");
  await expect(content).not.toContainText("hidden body");
  await expect(content).toContainText("shown body");
  await expect(content).toContainText("Tip");
  await expect(content).not.toContainText("[!warning]");
  // One button per foldable callout, also with a closed body splitting the view.
  await expect(page.getByRole("button", { name: "Open callout" })).toHaveCount(
    1,
  );

  await page.getByRole("button", { name: "Open callout" }).click();
  await expect(content).toContainText("hidden body");
  await page.getByRole("button", { name: "Close callout" }).first().click();
  await expect(content).not.toContainText("hidden body");

  // By keyboard on its title line, where the marker shows.
  await content.getByText("top").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(content).toContainText("[!warning]-");
  await page.keyboard.press("Control+Enter");
  await expect(content).toContainText("hidden body");

  await page.waitForTimeout(1300);
  expect(readFileSync(note, "utf8")).toBe(text);
});

test("in a write-protected note a table shows and cannot be edited", async ({
  app,
}) => {
  const folder = app.folder("Tables-");
  const note = join(folder, "Plan.md");
  const text = "| a | b |\r\n|---|---|\n| 1 | 2 |\n";
  writeFileSync(note, text);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  // Mixed line endings open read-only.
  await expect(page.getByText("mixes Windows and Unix")).toBeVisible();
  await expect(page.locator(".cm-content table")).toBeVisible();
  await cell(page, 1, 0).click();
  await expect(input(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add row" })).toHaveCount(0);
  expect(readFileSync(note, "utf8")).toBe(text);
});
