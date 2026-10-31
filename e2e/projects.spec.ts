import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
