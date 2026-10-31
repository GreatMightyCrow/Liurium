import { expect, test } from "./app";

test("Settings shows what the Rust core reports", async ({ app }) => {
  const page = await app.launch();
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
  // Both values come from the real app_info command.
  const facts = page.locator("dd");
  await expect(facts).toHaveText([/^\d+\.\d+\.\d+$/, "Ready"]);
});
