import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

/** A note deleted outside, with unsaved text: closing has to ask. */
async function unsavedInDeletedNote(page: Page, note: string) {
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
    .getByRole("link", { name: "Plan.md" })
    .click();
  await expect(page.locator(".cm-content")).toBeVisible();

  rmSync(note);
  await expect(
    page.getByRole("alert").filter({ hasText: "deleted or moved" }),
  ).toBeVisible();
  await page.locator(".cm-content").click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("mine");
}

/** The title bar's button; the note's bar has a "Close" of its own. */
function closeWindow(page: Page) {
  return page
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
}

test("closing with unsaved text asks in Liurium's dialog; Cancel stays", async ({
  app,
}) => {
  const folder = app.folder("Closing-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await unsavedInDeletedNote(page, note);

  await closeWindow(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Your changes to “Plan.md” are not saved.",
  );
  await expect(dialog).toContainText("deleted or moved outside Liurium");

  // The buttons stay inside the dialog; a long label once stuck out of its edge.
  const edge = await dialog.boundingBox();
  const kept = await dialog
    .getByRole("button", { name: "Keep copy and close" })
    .boundingBox();
  const cancel = await dialog
    .getByRole("button", { name: "Cancel" })
    .boundingBox();
  expect((kept?.x ?? 0) + (kept?.width ?? 0)).toBeLessThan(
    (edge?.x ?? 0) + (edge?.width ?? 0) - 8,
  );
  // On one row, so the choices read together.
  expect(kept?.y).toBe(cancel?.y);

  // Longer than a page gets to answer: one that shows the question keeps the window.
  await page.waitForTimeout(3500);
  await expect(dialog).toBeVisible();
  expect(existsSync(join(folder, "Plan (conflict).md"))).toBe(false);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("mine");
  expect(existsSync(note)).toBe(false);
});

test("keeping a copy saves the text under a new name and the app exits", async ({
  app,
}) => {
  const folder = app.folder("Closing-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await unsavedInDeletedNote(page, note);

  await closeWindow(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Keep copy and close" })
    .click();

  await app.exited();
  expect(readFileSync(join(folder, "Plan (conflict).md"), "utf8")).toBe(
    "one\nmine",
  );
  expect(existsSync(note)).toBe(false);
});

test("closing without saving leaves no file and the app exits", async ({
  app,
}) => {
  const folder = app.folder("Closing-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await unsavedInDeletedNote(page, note);

  await closeWindow(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard and close" })
    .click();

  await app.exited();
  expect(existsSync(note)).toBe(false);
  expect(existsSync(join(folder, "Plan (conflict).md"))).toBe(false);
});

test("a page that does not answer does not keep the window open or lose the text", async ({
  app,
}) => {
  const folder = app.folder("Closing-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "one\n");
  const page = await app.launch({ pick: folder });
  await unsavedInDeletedNote(page, note);
  // Give Rust the typing, then freeze the page. The close comes from Windows, as
  // Alt + F4 or the taskbar do, because a frozen page cannot start one.
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.setTimeout(() => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        // Frozen, as a hung page is.
      }
    }, 0);
  });
  await page.waitForTimeout(200);

  app.closeFromWindows();

  await app.exited();
  expect(readFileSync(join(folder, "Plan (conflict).md"), "utf8")).toBe(
    "one\nmine",
  );
  expect(existsSync(note)).toBe(false);
});
