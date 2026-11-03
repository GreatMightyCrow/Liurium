import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openProjects(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Projects" }),
  ).toBeFocused();
}

test("a folder with notes becomes a project and opens again after a restart", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  const note = join(folder, "readme.md");
  writeFileSync(note, "# Garden\n");
  const name = basename(folder);

  let page = await app.launch({ pick: folder });
  await openProjects(page);
  await expect(
    page.getByRole("heading", { name: "No project yet" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();

  page = await app.launch();
  await openProjects(page);
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByText(folder, { exact: true })).toBeVisible();

  // Liurium added .liurium and changed nothing else.
  expect(readdirSync(folder).sort()).toEqual([".liurium", "readme.md"]);
  expect(readFileSync(note, "utf8")).toBe("# Garden\n");
  expect(readdirSync(join(folder, ".liurium")).sort()).toEqual([
    ".gitignore",
    "project.db",
  ]);
});

test("a project in a sync folder is warned about once", async ({ app }) => {
  const oneDrive = app.folder("OneDrive-");
  const folder = join(oneDrive, "Garden");
  mkdirSync(folder);
  const warning =
    "OneDrive syncs this folder. Open the project on one computer at a time, or changes made on two at once can conflict.";

  let page = await app.launch({ pick: folder, oneDrive });
  await openProjects(page);
  await page.getByRole("button", { name: "Add project folder" }).click();
  const open = page.getByRole("region", { name: "Garden" });
  await expect(open).toContainText(warning);

  page = await app.launch({ oneDrive });
  await openProjects(page);
  await expect(page.getByRole("region", { name: "Garden" })).toContainText(
    "Open now",
  );
  await expect(page.getByText("syncs this folder")).toHaveCount(0);
});

/** Every file below `root` with its bytes and modified time. */
function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .sort()
    .map((rel) => {
      const path = join(root, rel);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        return `${rel}/`;
      }
      const hash = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      return `${rel} ${String(stat.mtimeMs)} ${hash}`;
    });
}

test("a moved project is located, and removing it from the list leaves its folder alone", async ({
  app,
}) => {
  const before = app.folder("Moved-");
  writeFileSync(join(before, "readme.md"), "# Moved\n");
  const name = basename(before);

  let page = await app.launch({ pick: before });
  await openProjects(page);
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await app.stop();

  const after = join(app.folder("Target-"), "Garden");
  renameSync(before, after);

  page = await app.launch({ pick: after });
  await openProjects(page);
  const row = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { level: 3, name }),
  });
  await expect(row).toContainText("Folder not found");
  await row.getByRole("button", { name: "Locate folder" }).click();
  // Once open, the project moves out of the list to the top of the page.
  const open = page.getByRole("region", { name });
  await expect(open).toContainText("Open now");
  await expect(open).toContainText(after);
  await expect(row).toHaveCount(0);

  const files = snapshot(after);
  await open.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Remove from list…" }).click();
  await page.getByRole("button", { name: "Remove from list" }).click();
  await expect(
    page.getByRole("heading", { name: "No project yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add project folder" }),
  ).toBeFocused();

  await app.stop();
  expect(snapshot(after)).toEqual(files);
  expect(readFileSync(join(after, "readme.md"), "utf8")).toBe("# Moved\n");
});
