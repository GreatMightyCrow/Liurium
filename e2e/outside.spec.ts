import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function addProject(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
}

async function openNotes(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Notes" })
    .click();
}

function tree(page: Page) {
  return page.getByRole("navigation", { name: "Notes in this project" });
}

async function openNote(page: Page, name: string) {
  await tree(page).getByRole("link", { name }).click();
  await expect(
    page.getByRole("heading", { level: 2, name, exact: true }),
  ).toBeVisible();
  // The heading shows while the note still loads; the editor means Rust has read it.
  await expect(page.locator(".cm-content")).toBeVisible();
}

/** CodeMirror ignores keys for a moment after focus changes (M3-006). */
async function intoEditor(page: Page) {
  await page.locator(".cm-content").click();
  await page.waitForTimeout(100);
}

test("a change outside reloads the note, keeps the cursor, and clears undo", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\ntwo\n");
  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  // Something to undo, saved; then the cursor at the end.
  await intoEditor(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("mine\n");
  await expect.poll(() => readFileSync(note, "utf8")).toBe("one\ntwo\nmine\n");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();

  writeFileSync(note, "zero\none\ntwo\nmine\n");

  await expect(
    page.getByRole("status").filter({ hasText: "Updated from outside" }),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("zero");

  // Undo finds nothing, so the outside change cannot be undone by accident.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content")).toContainText("zero");
  await expect(page.locator(".cm-content")).toContainText("mine");
  expect(readFileSync(note, "utf8")).toBe("zero\none\ntwo\nmine\n");

  // The cursor stayed at the end, and typing saves over the new text.
  await page.keyboard.type("end");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe("zero\none\ntwo\nmine\nend");
});

test("with unsaved text the choices come at once and nothing is overwritten", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  await intoEditor(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("mine");
  writeFileSync(note, "theirs\n");

  const bar = page.getByRole("alert");
  await expect(bar).toContainText("This note was changed outside Liurium.");
  await expect(page.locator(".cm-content")).toContainText("mine");
  // Saving stays stopped, also after the save delay has passed.
  await page.waitForTimeout(1300);
  expect(readFileSync(note, "utf8")).toBe("theirs\n");

  await bar.getByRole("button", { name: "Keep both" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Plan (conflict).md" }),
  ).toBeVisible();
  expect(readFileSync(note, "utf8")).toBe("theirs\n");
  expect(readFileSync(join(folder, "Plan (conflict).md"), "utf8")).toBe(
    "one\nmine",
  );
});

test("a deleted note stays open, is not saved, and can be created again", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  mkdirSync(join(folder, "Ideas"));
  const note = join(folder, "Ideas", "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await tree(page).getByRole("button", { name: "Ideas", exact: true }).click();
  await openNote(page, "Plan.md");

  rmSync(join(folder, "Ideas"), { recursive: true });

  const bar = page.getByRole("alert");
  await expect(bar).toContainText("deleted or moved outside Liurium");
  await expect(page.locator(".cm-content")).toContainText("one");

  // Typing does not bring the file back.
  await intoEditor(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("kept");
  await page.waitForTimeout(1300);
  expect(existsSync(note)).toBe(false);

  await bar.getByRole("button", { name: "Create again" }).click();
  await expect
    .poll(() => (existsSync(note) ? readFileSync(note, "utf8") : null))
    .toBe("one\nkept");
  await expect(bar).toHaveCount(0);
});

test("closing a deleted note with unsaved text asks and then drops it", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  rmSync(note);
  const bar = page.getByRole("alert").filter({ hasText: "deleted or moved" });
  await expect(bar).toBeVisible();
  await intoEditor(page);
  await page.keyboard.type("mine");

  await bar.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Drop my text" }).click();

  await expect(page.getByText("Choose a note on the left")).toBeVisible();
  expect(existsSync(note)).toBe(false);
});

test("a note renamed outside is followed with its unsaved text, and the list updates", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  renameSync(note, join(folder, "Moved.md"));

  await expect(
    page.getByRole("heading", { level: 2, name: "Moved.md" }),
  ).toBeVisible();
  await expect(
    tree(page).getByRole("link", { name: "Moved.md" }),
  ).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Plan.md" })).toHaveCount(
    0,
  );

  await intoEditor(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("more");
  await expect
    .poll(() => readFileSync(join(folder, "Moved.md"), "utf8"))
    .toBe("one\nmore");
  expect(existsSync(note)).toBe(false);
});

test("without change reports the window getting focus finds the changes", async ({
  app,
}) => {
  const folder = app.folder("Outside-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder, noWatch: true });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  writeFileSync(note, "from outside\n");
  writeFileSync(join(folder, "New.md"), "new\n");
  // Long enough to show that nothing reports these changes by itself, and past the
  // limit on how often focus looks.
  await page.waitForTimeout(2100);
  await expect(tree(page).getByRole("link", { name: "New.md" })).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("one");

  // The handler listens for this event; real focus needs real OS input (ADR-0019).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(tree(page).getByRole("link", { name: "New.md" })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("from outside");
});
