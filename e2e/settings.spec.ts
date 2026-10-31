import { expect, test } from "./app";

test("Settings shows what the Rust core reports", async ({ app }) => {
  await expect(
    app.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();

  await app
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();

  await expect(
    app.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeFocused();
  // Both values come from the real app_info command.
  const facts = app.locator("dd");
  await expect(facts).toHaveText([/^\d+\.\d+\.\d+$/, "Ready"]);
});
