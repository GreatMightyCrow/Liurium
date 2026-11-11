import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./app";

function write(folder: string, rel: string, text: string, minutesAgo: number) {
  const path = join(folder, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, when, when);
}

test("the dashboard shows the open project's recent notes and opens them", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  write(folder, "Old.md", "# Old\n", 60);
  write(folder, "Ideas/Plan.md", "# Plan\n", 5);
  write(folder, "README.md", "# Garden\n", 30);

  const page = await app.launch({ pick: folder });
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  const recent = page.getByRole("region", { name: "Recent notes" });
  await expect(
    recent.getByText("No project is open. Open one to see its notes here."),
  ).toBeVisible();

  await recent.getByRole("button", { name: "Go to Projects" }).click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Dashboard" })
    .click();

  const links = recent.getByRole("link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toContainText("Plan.md");
  await expect(links.nth(0)).toContainText("Ideas · ");
  await expect(links.nth(1)).toContainText("README.md");
  await expect(links.nth(2)).toContainText("Old.md");

  // A note written outside Liurium shows without leaving the page.
  write(folder, "Outside.md", "# Outside\n", 0);
  await expect(links.nth(0)).toContainText("Outside.md");

  await links.filter({ hasText: "README.md" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Notes" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/notes\/README\.md$/);
});
