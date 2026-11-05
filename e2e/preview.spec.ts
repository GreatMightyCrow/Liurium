import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openNote(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name })
    .click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function start(page: Page) {
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
}

const content = (page: Page) => page.locator(".cm-content");

test("the file stays byte for byte while the view changes", async ({ app }) => {
  const folder = app.folder("Preview-");
  const note = join(folder, "Plan.md");
  const bytes =
    "﻿# Title\r\n\r\n**bold** *it* ~~gone~~ `code` [[Other|the other]]\r\n\r\n- item\r\n- [ ] open\r\n- [x] done\r\n\r\n> quote\r\n\r\n---\r\n\r\n```js\r\nlet a = 1;\r\n```\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n";
  writeFileSync(note, bytes);
  writeFileSync(join(folder, "Other.md"), "x\n");
  const page = await app.launch({ pick: folder });
  await start(page);
  await openNote(page, "Plan.md");

  // Formatted: the marks are gone from what shows, the words are there.
  // Rust's links arrive a moment after the text.
  await expect(page.locator(".cm-link-note")).toHaveText("the other");
  const shown = await content(page).innerText();
  for (const mark of ["**", "~~", "[[", "]]", "```", "# Title", "> quote"]) {
    expect(shown).not.toContain(mark);
  }
  expect(shown).toContain("| a | b |");

  // Walk through every line, then through the source view and back.
  await content(page).click();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 22; line += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.getByRole("button", { name: "Show source" }).click();
  await expect(content(page)).toContainText("**bold**");
  await page.getByRole("button", { name: "Show live preview" }).click();
  await expect(content(page)).not.toContainText("**bold**");
  await page.waitForTimeout(1300);

  expect(readFileSync(note, "utf8")).toBe(bytes);
});

test("marks come back at the cursor, and typing and undo work inside them", async ({
  app,
}) => {
  const folder = app.folder("Preview-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "first\n\nsome **bold** word\n\nlast\n");
  const page = await app.launch({ pick: folder });
  await start(page);
  await openNote(page, "Plan.md");
  await expect(content(page)).not.toContainText("**");

  await content(page).getByText("first").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await expect(content(page)).not.toContainText("**");
  for (let step = 0; step < "some ".length; step += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect(content(page)).toContainText("**bold**");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("very ");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("first\n\nsome **very bold** word\n\nlast\n");

  await page.keyboard.press("Control+z");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("first\n\nsome **bold** word\n\nlast\n");

  await page.keyboard.press("Control+End");
  await expect(content(page)).not.toContainText("**");
});

test("a checkbox writes one normal edit, by click and by Ctrl + Enter", async ({
  app,
}) => {
  const folder = app.folder("Preview-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "- [ ] open\n- [x] done\n\nend\n");
  const page = await app.launch({ pick: folder });
  await start(page);
  await openNote(page, "Plan.md");

  const boxes = content(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();

  await boxes.nth(0).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("- [x] open\n- [x] done\n\nend\n");
  await expect(boxes.nth(0)).toBeChecked();

  await content(page).getByText("end").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("- [ ] open\n- [x] done\n\nend\n");

  await content(page).getByText("open").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("- [x] open\n- [x] done\n\nend\n");
});

test("in live preview a plain click follows a link; in the source view it does not", async ({
  app,
}) => {
  const folder = app.folder("Preview-");
  const record = join(app.folder("Record-"), "opened.txt");
  writeFileSync(
    join(folder, "Plan.md"),
    "[[Other|the other]] and [docs](https://example.org/docs)\n\nplain line\n",
  );
  writeFileSync(join(folder, "Other.md"), "x\n");
  const page = await app.launch({ pick: folder, openedLinks: record });
  await start(page);
  await openNote(page, "Plan.md");
  const external = page.locator(".cm-link-external");
  await expect(external).toHaveText("docs");

  await external.click();
  await expect
    .poll(() =>
      existsSync(record) ? readFileSync(record, "utf8").trim() : null,
    )
    .toBe("https://example.org/docs");
  // The link stays shown: the click did not leave the cursor in it.
  await expect(external).toHaveText("docs");

  await page.getByRole("button", { name: "Show source" }).click();
  await expect(content(page)).toContainText("[docs](https://example.org/docs)");
  await external.click();
  await page.waitForTimeout(300);
  expect(readFileSync(record, "utf8").trim()).toBe("https://example.org/docs");
  await page.getByRole("button", { name: "Show live preview" }).click();

  // Back in live preview with the cursor elsewhere: the note link follows.
  await content(page).getByText("plain line").click();
  await expect(page.locator(".cm-link-note")).toHaveText("the other");
  await page.locator(".cm-link-note").click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Other.md" }),
  ).toBeVisible();
});

test("a link Rust does not accept shows its full source", async ({ app }) => {
  const folder = app.folder("Preview-");
  writeFileSync(join(folder, "Plan.md"), "[x](javascript:alert(1))\n\nend\n");
  const page = await app.launch({ pick: folder });
  await start(page);
  await openNote(page, "Plan.md");

  await expect(content(page)).toContainText("[x](javascript:alert(1))");
});
