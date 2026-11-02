import { type Page } from "@playwright/test";
import { expect, test } from "./app";

async function openSettings(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeFocused();
}

test("Settings shows what the Rust core reports", async ({ app }) => {
  const page = await app.launch();
  await openSettings(page);

  // Both values come from the real app_info command.
  const facts = page.locator("dd");
  await expect(facts).toHaveText([/^\d+\.\d+\.\d+$/, "Ready"]);
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
