import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openNotes(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Notes" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Notes" }),
  ).toBeFocused();
}

async function addProject(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
}

function saveStatus(page: Page) {
  return page
    .getByRole("region", { name: /\.md$/ })
    .getByRole("status")
    .first();
}

test("a note opens in the editor under the strict CSP and saves with its own line endings", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  mkdirSync(join(folder, "Ideas"));
  const note = join(folder, "Ideas", "Plan.md");
  writeFileSync(note, "# Plan\r\nfirst line\r\n");

  const page = await app.launch({ pick: folder });
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      violations.push(message.text());
    }
  });
  await addProject(page);
  await openNotes(page);
  await page.getByRole("button", { name: "Ideas", exact: true }).click();
  await page.getByRole("link", { name: "Plan.md" }).click();

  const editor = page.getByRole("textbox", { name: "Plan.md" });
  await expect(editor).toBeVisible();
  // CodeMirror's own styles apply inside the shadow root (ADR-0020).
  const display = await page
    .locator(".cm-editor")
    .evaluate((element) => getComputedStyle(element).display);
  expect(display).toBe("flex");

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("added");
  await page.keyboard.press("Enter");
  await page.keyboard.type("next  ");
  await expect(saveStatus(page)).toHaveText("Saved");
  expect(readFileSync(note, "utf8")).toBe(
    "# Plan\r\nfirst line\r\nadded\r\nnext  ",
  );

  // Ctrl + S saves at once, long before the automatic save.
  await page.keyboard.type("!");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFileSync(note, "utf8")).toMatch(/next {2}!$/);

  expect(violations).toEqual([]);
});

test("a change made outside is not overwritten; keep both writes a copy", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "mine\n");

  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await page.getByRole("link", { name: "Plan.md" }).click();
  const editor = page.getByRole("textbox", { name: "Plan.md" });
  await expect(editor).toBeVisible();

  writeFileSync(note, "theirs, from outside\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(note, later, later);
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("edited");
  await page.keyboard.press("Control+s");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This note was changed outside Liurium.");
  expect(readFileSync(note, "utf8")).toBe("theirs, from outside\n");

  await alert.getByRole("button", { name: "Keep both" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Plan (conflict).md" }),
  ).toBeVisible();
  expect(readFileSync(note, "utf8")).toBe("theirs, from outside\n");
  expect(readFileSync(join(folder, "Plan (conflict).md"), "utf8")).toBe(
    "mine\nedited",
  );
});

test("closing the window right after typing saves the note", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, "start\r\n");

  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await page.getByRole("link", { name: "Plan.md" }).click();
  const editor = page.getByRole("textbox", { name: "Plan.md" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed just before closing");

  // The fixture closes the app through its own Close button before starting it
  // again; the automatic save has not run yet.
  await app.launch();

  expect(readFileSync(note, "utf8")).toBe("start\r\ntyped just before closing");
  expect(existsSync(join(folder, "Plan (conflict).md"))).toBe(false);
});
