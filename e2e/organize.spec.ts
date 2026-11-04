import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

function tree(page: Page) {
  return page.getByRole("navigation", { name: "Notes in this project" });
}

test("notes and folders are created, renamed, moved, and deleted to the project's trash", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  writeFileSync(join(folder, "README.md"), "# Garden\r\n");

  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);

  // New folder, then a new note inside it, which opens in the editor.
  await page.getByRole("button", { name: "New folder" }).click();
  let dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Ideas");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(
    tree(page).getByRole("button", { name: "Ideas", exact: true }),
  ).toBeVisible();
  expect(existsSync(join(folder, "Ideas"))).toBe(true);

  await page.getByRole("button", { name: "New note" }).click();
  dialog = page.getByRole("dialog", { name: "New note" });
  await expect(dialog).toContainText("A new note in “Ideas”");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Plan");
  await dialog.getByRole("button", { name: "Create note" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Plan.md" }),
  ).toBeVisible();
  expect(readFileSync(join(folder, "Ideas", "Plan.md"), "utf8")).toBe("");

  // Type, then rename with F2: the open note follows with its text.
  const editor = page.getByRole("textbox", { name: "Plan.md" });
  await editor.click();
  await page.keyboard.type("first idea");
  await tree(page).getByRole("link", { name: "Plan.md" }).focus();
  await page.keyboard.press("F2");
  dialog = page.getByRole("dialog", { name: "Rename “Plan.md”" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Roadmap");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Roadmap.md" }),
  ).toBeVisible();
  expect(existsSync(join(folder, "Ideas", "Plan.md"))).toBe(false);
  expect(readFileSync(join(folder, "Ideas", "Roadmap.md"), "utf8")).toBe(
    "first idea",
  );

  // Move with the right-click menu (Liurium's own, not the browser's).
  await tree(page).getByRole("link", { name: "Roadmap.md" }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  dialog = page.getByRole("dialog", { name: "Move “Roadmap.md”" });
  await dialog.getByRole("radio", { name: "Project folder (top)" }).click();
  await dialog.getByRole("button", { name: "Move here" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Roadmap.md" }),
  ).toBeVisible();
  await expect.poll(() => existsSync(join(folder, "Roadmap.md"))).toBe(true);
  expect(existsSync(join(folder, "Ideas", "Roadmap.md"))).toBe(false);

  // Delete the folder with Delete; it asks first and goes to .liurium/trash.
  await tree(page).getByRole("button", { name: "Ideas", exact: true }).focus();
  await page.keyboard.press("Delete");
  dialog = page.getByRole("dialog", { name: "Delete “Ideas”?" });
  await expect(dialog).toContainText(".liurium/trash");
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    tree(page).getByRole("button", { name: "Ideas", exact: true }),
  ).toHaveCount(0);
  expect(existsSync(join(folder, "Ideas"))).toBe(false);
  const trash = join(folder, ".liurium", "trash");
  const [batch] = readdirSync(trash);
  expect(existsSync(join(trash, batch, "Ideas"))).toBe(true);
  expect(
    readFileSync(join(folder, ".liurium", ".gitignore"), "utf8"),
  ).toContain("trash/");

  // Delete the open note: the editor closes.
  await tree(page).getByRole("link", { name: "Roadmap.md" }).focus();
  await page.keyboard.press("Delete");
  await page
    .getByRole("dialog", { name: "Delete “Roadmap.md”?" })
    .getByRole("button", { name: "Move to trash" })
    .click();
  await expect(
    page.getByText("Choose a note on the left to open it."),
  ).toBeVisible();
  expect(existsSync(join(folder, "Roadmap.md"))).toBe(false);
  expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("# Garden\r\n");
});
