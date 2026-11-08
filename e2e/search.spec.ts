import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

/** The text of the editor's line that holds the cursor. */
function cursorLine(page: Page) {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll("div")].find((element) =>
      element.shadowRoot?.querySelector(".cm-editor"),
    );
    const root = host?.shadowRoot as
      (ShadowRoot & { getSelection?: () => Selection | null }) | undefined;
    const node = root?.getSelection?.()?.anchorNode ?? null;
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest(".cm-line")?.textContent ?? null;
  });
}

test("Ctrl + Shift + F searches the notes, and a result opens its note at the match", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  const garden =
    "# Garden\r\n\r\nFirst line.\r\nWe plant the Tomatoes early.\r\n";
  writeFileSync(join(folder, "Garden.md"), garden);
  writeFileSync(join(folder, "Tomato soup.md"), "Soup.\n");
  writeFileSync(join(folder, "Other.md"), "Nothing here.\n");

  const page = await app.launch({ pick: folder });
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();

  // From another page the shortcut leads to the Search tab of Notes.
  await page.keyboard.press("Control+Shift+F");
  const field = page.getByRole("searchbox", { name: "Search notes" });
  await expect(field).toBeFocused();
  await expect(page.getByRole("tab", { name: "Search" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await field.fill("tomato");
  const results = page.getByRole("list", { name: "Notes" });
  // The name first, then the text; the match is marked.
  await expect(results.getByRole("button")).toHaveText([
    "Tomato soup.md",
    "Garden.mdWe plant the Tomatoes early.",
  ]);
  await expect(results.locator("mark")).toHaveText("Tomato");

  await results.getByRole("button", { name: /Garden\.md/ }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Garden.md", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => cursorLine(page))
    .toBe("We plant the Tomatoes early.");

  // The search stays when coming back; the note stays open with the shortcut.
  await page.getByRole("tab", { name: "Files" }).click();
  await page.keyboard.press("Control+Shift+F");
  await expect(field).toHaveValue("tomato");
  await expect(
    page.getByRole("heading", { level: 2, name: "Garden.md", exact: true }),
  ).toBeVisible();

  // The sidebar's Search leads there too.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Search" })
    .click();
  await expect(field).toBeFocused();

  // Searching writes nothing.
  expect(readFileSync(join(folder, "Garden.md"), "utf8")).toBe(garden);
});
