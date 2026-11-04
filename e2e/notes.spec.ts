import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openArea(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name })
    .click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeFocused();
}

function write(folder: string, rel: string, text: string) {
  const path = join(folder, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("the Notes page lists the project's notes and leaves package folders out", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  write(folder, "README.md", "# Garden\n");
  write(folder, "Ideas/Plan.markdown", "plan\n");
  write(folder, "Ideas/sketch.txt", "not a note\n");
  write(folder, "node_modules/pkg/README.md", "package docs\n");
  write(folder, ".obsidian/notes.md", "settings\n");

  let page = await app.launch({ pick: folder });
  await openArea(page, "Notes");
  await expect(
    page.getByRole("heading", { name: "No project is open" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to Projects" }).click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();

  await openArea(page, "Notes");
  await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  const top = page.getByRole("region", { name: "Project folder" });
  await expect(top.getByRole("listitem")).toHaveText([/README\.md/]);
  const ideas = page.getByRole("region", { name: "Ideas" });
  await expect(ideas.getByRole("listitem")).toHaveText([/Plan\.markdown/]);

  // After a restart the list comes from the walk again, with the new note.
  write(folder, "Ideas/Next.md", "next\n");
  page = await app.launch();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  await openArea(page, "Notes");
  await expect(page.getByText("3 notes", { exact: true })).toBeVisible();

  // The cache lives in the app data folder, never in the project.
  const caches = readdirSync(join(app.dataDir, "cache")).filter((name) =>
    name.endsWith(".db"),
  );
  expect(caches).toHaveLength(1);
  expect(readdirSync(folder).sort()).toEqual([
    ".liurium",
    ".obsidian",
    "Ideas",
    "README.md",
    "node_modules",
  ]);
  expect(existsSync(join(folder, ".liurium", "cache"))).toBe(false);
});
