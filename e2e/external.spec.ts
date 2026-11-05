import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openPlan(page: Page) {
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
}

function opened(record: string): string[] {
  return existsSync(record)
    ? readFileSync(record, "utf8").split("\n").filter(Boolean)
    : [];
}

test("external links open by Ctrl + click and Ctrl + Enter; a misleading one asks first", async ({
  app,
}) => {
  const folder = app.folder("External-");
  const record = join(app.folder("Record-"), "opened.txt");
  writeFileSync(
    join(folder, "Plan.md"),
    "[docs](https://example.org/docs)\n\nhttps://example.org/bare_address.\n\n[www.meinebank.de](https://boese-seite.example/)\n\n[bad](javascript:alert(1))\n",
  );
  const page = await app.launch({ pick: folder, openedLinks: record });
  await openPlan(page);

  const links = page.locator(".cm-link-external");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute(
    "title",
    /^https:\/\/example\.org\/docs\n/,
  );

  await links.nth(0).click({ modifiers: ["Control"] });
  await expect.poll(() => opened(record)).toEqual(["https://example.org/docs"]);

  // A bare address stops before the sentence's full stop.
  await links.nth(1).click({ modifiers: ["Control"] });
  await expect
    .poll(() => opened(record))
    .toEqual(["https://example.org/docs", "https://example.org/bare_address"]);

  await links.nth(2).click({ modifiers: ["Control"] });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("www.meinebank.de");
  await expect(dialog).toContainText("https://boese-seite.example/");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(opened(record)).toHaveLength(2);

  await links.nth(2).click({ modifiers: ["Control"] });
  await dialog.getByRole("button", { name: "Open address" }).click();
  await expect.poll(() => opened(record)).toHaveLength(3);

  // A scheme Liurium does not open stays plain text: nothing to click.
  const bad = page.locator(".cm-content").getByText("javascript:alert(1)");
  await bad.click({ modifiers: ["Control"] });
  await page.waitForTimeout(300);
  expect(opened(record)).toHaveLength(3);
});
