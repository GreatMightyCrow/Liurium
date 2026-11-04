import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openNote(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name })
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name, exact: true }),
  ).toBeVisible();
}

test("a link typed in one note shows as a backlink in the other, and leads back", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  writeFileSync(join(folder, "Plan.md"), "# Plan\n");
  writeFileSync(join(folder, "Home.md"), "Start here.\n");

  const page = await app.launch({ pick: folder });
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

  await openNote(page, "Plan.md");
  const band = page.getByRole("region", { name: "Backlinks" });
  await expect(band).toContainText("No other note links here yet.");

  // Typed and saved in Liurium, with no walk in between.
  await openNote(page, "Home.md");
  await page.getByRole("textbox", { name: "Home.md" }).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Then read [[Plan]] next.");
  await page.keyboard.press("Control+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await openNote(page, "Plan.md");
  await expect(
    band.getByRole("button", { name: "Linked from 1 note" }),
  ).toHaveAttribute("aria-expanded", "true");
  const line = band.getByRole("button", {
    name: "Open Home.md at: Then read [[Plan]] next.",
  });
  await line.click();

  await expect(
    page.getByRole("heading", { level: 2, name: "Home.md", exact: true }),
  ).toBeVisible();
  // The cursor sits on the line with the link.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = [...document.querySelectorAll("div")].find((element) =>
          element.shadowRoot?.querySelector(".cm-editor"),
        );
        const root = host?.shadowRoot as
          (ShadowRoot & { getSelection?: () => Selection | null }) | undefined;
        const node = root?.getSelection?.()?.anchorNode ?? null;
        const element = node instanceof Element ? node : node?.parentElement;
        return element?.closest(".cm-line")?.textContent ?? null;
      }),
    )
    .toBe("Then read [[Plan]] next.");
});
