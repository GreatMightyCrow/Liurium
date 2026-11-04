import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Page } from "@playwright/test";
import { expect, test } from "./app";

async function openSettings(page: Page, startPage = "Dashboard") {
  await expect(
    page.getByRole("heading", { level: 1, name: startPage }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeFocused();
}

async function openSection(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name })
    .click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText(name);
}

test("Settings shows what the Rust core reports", async ({ app }) => {
  const page = await app.launch();
  await openSettings(page);
  await openSection(page, "About");

  // Version and data status come from the real app_info command.
  const facts = page.locator("dd");
  await expect(facts).toHaveText([/^\d+\.\d+\.\d+$/, "Ready", "GPL-3.0-only"]);

  // The Data section names the test's own app data folder.
  await openSection(page, "Data");
  await expect(page.getByText(app.dataDir, { exact: true })).toBeVisible();
  await expect(page.getByText(/^No backup copies yet\./)).toBeVisible();
});

test("the project list at start opens no project; the default reopens it", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  writeFileSync(join(folder, "readme.md"), "# Garden\n");
  const name = basename(folder);
  let page = await app.launch({ pick: folder });
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByRole("region", { name })).toContainText("Open now");
  await openSettings(page, "Projects");
  await openSection(page, "Startup");
  await page.getByRole("radio", { name: "Show the project list" }).click();
  await expect(
    page.getByRole("radio", { name: "Show the project list" }),
  ).toBeChecked();

  page = await app.launch();
  await expect(
    page.getByRole("heading", { level: 1, name: "Projects" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name })).toBeVisible();
  await expect(page.getByText("Open now")).toHaveCount(0);

  await openSettings(page, "Projects");
  await openSection(page, "Startup");
  await page.getByRole("radio", { name: "Open the last project" }).click();
  await expect(
    page.getByRole("radio", { name: "Open the last project" }),
  ).toBeChecked();
  page = await app.launch();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  // The project opened in the session before is the last one, and it is open again.
  await expect(page.getByRole("region", { name })).toContainText("Open now");
});

test("Ctrl + Plus zooms the window and the zoom stays after a restart", async ({
  app,
}) => {
  let page = await app.launch();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  const normal = await page.evaluate(() => window.devicePixelRatio);

  await page.keyboard.press("Control+Equal");
  // Rust zooms the webview; the page sees it as a larger pixel ratio.
  await expect
    .poll(() => page.evaluate(() => window.devicePixelRatio))
    .toBeCloseTo(normal * 1.1, 2);
  await openSettings(page);
  await expect(page.getByRole("status", { name: "Zoom" })).toHaveText("110 %");

  page = await app.launch();
  // Read only once the page has loaded; earlier, the start page is still on its way.
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.devicePixelRatio))
    .toBeCloseTo(normal * 1.1, 2);
  await openSettings(page);
  await expect(page.getByRole("status", { name: "Zoom" })).toHaveText("110 %");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect
    .poll(() => page.evaluate(() => window.devicePixelRatio))
    .toBeCloseTo(normal, 2);
});

test("theme and mode change at once and stay after a restart; the frame after it", async ({
  app,
}) => {
  let page = await app.launch();
  await openSettings(page);
  const root = page.locator("html");
  await expect(
    page.getByRole("radio", { name: "Orange", exact: true }),
  ).toBeChecked();
  await expect(root).toHaveAttribute("data-accent", "orange");

  await page.getByRole("radio", { name: "Mint", exact: true }).click();
  await expect(root).toHaveAttribute("data-accent", "mint");
  await expect(root).toHaveAttribute("data-base", "cool");

  // Rust sets the window's theme; WebView2 reports it to the page.
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(root).toHaveAttribute("data-mode", "light");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(root).toHaveAttribute("data-mode", "dark");

  await page.getByRole("radio", { name: "No title bar" }).click();
  await expect(
    page.getByText("The new window frame applies after Liurium restarts."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart now" })).toBeVisible();
  // The running window keeps its frame until the restart.
  expect(new URL(page.url()).searchParams.get("frame")).toBe("liurium");

  page = await app.launch();
  await openSettings(page);
  const url = new URL(page.url());
  expect(url.searchParams.get("frame")).toBe("hidden");
  expect(url.searchParams.get("accent")).toBe("mint");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(
    page.getByRole("radio", { name: "Mint", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "No title bar" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Restart now" })).toHaveCount(
    0,
  );
});
