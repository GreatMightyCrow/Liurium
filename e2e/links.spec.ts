import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

function write(folder: string, rel: string, text: string) {
  const path = join(folder, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

async function openNote(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name })
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name, exact: true }),
  ).toBeVisible();
}

test("links are followed with Ctrl + click and Ctrl + Enter; missing and ambiguous ones ask", async ({
  app,
}) => {
  const folder = app.folder("Garden-");
  write(
    folder,
    "Home.md",
    "See [[Plan#Next steps]] and [[New idea]] and [[Dup]].\n",
  );
  write(folder, "Plan.md", "# Plan\n\nintro\n\n## Next steps\n\nmore\n");
  write(folder, "A/Dup.md", "a\n");
  write(folder, "B/Dup.md", "b\n");

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
  await openNote(page, "Home.md");

  // Rust's parse styles the links: found, missing, ambiguous.
  await expect(page.locator(".cm-link-note")).toHaveText("[[Plan#Next steps]]");
  await expect(page.locator(".cm-link-missing")).toHaveText("[[New idea]]");
  await expect(page.locator(".cm-link-ambiguous")).toHaveText("[[Dup]]");

  // Ctrl + click opens the note at the heading.
  await page.locator(".cm-link-note").click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("heading", { level: 2, name: "Plan.md", exact: true }),
  ).toBeVisible();
  // The cursor sits on the heading's line.
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
    .toBe("## Next steps");

  // Ctrl + Enter on a missing link asks, then creates and opens the note.
  await openNote(page, "Home.md");
  await page.locator(".cm-link-missing").click();
  await page.keyboard.press("Control+Enter");
  const create = page.getByRole("dialog", { name: "Create “New idea.md”?" });
  await create.getByRole("button", { name: "Create note" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "New idea.md", exact: true }),
  ).toBeVisible();
  expect(existsSync(join(folder, "New idea.md"))).toBe(true);

  // An ambiguous link asks which note and writes its path into the link.
  await openNote(page, "Home.md");
  await page.locator(".cm-link-ambiguous").click({ modifiers: ["Control"] });
  const which = page.getByRole("dialog", {
    name: "Which note does this link mean?",
  });
  await which.getByRole("radio", { name: "B/Dup.md" }).click();
  await which.getByRole("button", { name: "Use this note" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Dup.md", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => readFileSync(join(folder, "Home.md"), "utf8"))
    .toBe("See [[Plan#Next steps]] and [[New idea]] and [[B/Dup]].\n");

  // [[ offers notes; Enter inserts the link.
  await openNote(page, "Plan.md");
  await page.getByRole("textbox", { name: "Plan.md" }).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("[[Uniq");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeHidden();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Ne");
  // Right after [[ every note is offered; wait until the typed letters chose.
  await expect(
    page.locator(".cm-tooltip-autocomplete li[aria-selected]"),
  ).toContainText("New idea");
  // CodeMirror ignores Enter for 75 ms after the list changes (interactionDelay),
  // so a key pressed at once is not taken by mistake; a person is never that fast.
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe("# Plan\n\nintro\n\n## Next steps\n\nmore\n[[New idea]]");
});
