import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

async function openNotes(page: Page) {
  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("link", { name: "Notes" }).click();
}

async function addProject(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
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

const FRONT =
  "---\r\n# Why this note exists\r\ntitle: Plan # keep\r\ndue: 2026-10-20\r\ntags:\r\n  - garten\r\n---\r\n";

test("a property edit changes only its line, undoes, and the block is out of the editor's reach", async ({
  app,
}) => {
  const folder = app.folder("Props-");
  const note = join(folder, "Plan.md");
  writeFileSync(note, `${FRONT}Body text\r\n`);

  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plan.md");

  const box = page.getByRole("region", { name: "Properties" });
  await expect(box.getByLabel("Value of property title")).toHaveValue("Plan");
  await expect(box.getByLabel("Value of property due")).toHaveValue(
    "2026-10-20",
  );
  await expect(
    box.getByRole("button", { name: "garten", exact: true }),
  ).toBeVisible();
  // The block is hidden, the text is there.
  await expect(page.locator(".cm-content")).toContainText("Body text");
  await expect(page.locator(".cm-content")).not.toContainText("title:");

  // One line changes, comments stay, line endings stay.
  const title = box.getByLabel("Value of property title");
  await title.fill("Neuer Titel: 2");
  await title.press("Enter");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe(
      `${FRONT.replace("title: Plan # keep", 'title: "Neuer Titel: 2" # keep')}Body text\r\n`,
    );

  // Undo works from the editor, as for typing.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe(`${FRONT}Body text\r\n`);
  await expect(box.getByLabel("Value of property title")).toHaveValue("Plan");

  // Backspace at the start of the text and Select all with Delete leave the block.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Top ");
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toBe(`${FRONT}Top Body text\r\n`);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect.poll(() => readFileSync(note, "utf8")).toBe(FRONT);

  // A tag: added with #, removed with its X.
  const adding = box.getByLabel("Add to tags");
  await adding.fill("#idee");
  await adding.press("Enter");
  await expect(
    box.getByRole("button", { name: "idee", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toContain("tags:\r\n  - garten\r\n  - idee\r\n---\r\n");
  await box.getByRole("button", { name: "Remove garten" }).click();
  await expect
    .poll(() => readFileSync(note, "utf8"))
    .toContain("tags:\r\n  - idee\r\n---\r\n");

  // Clicking a tag filters the tree, as in the Tags view.
  await box.getByRole("button", { name: "idee", exact: true }).click();
  await expect(page.getByText("Showing notes tagged #idee")).toBeVisible();
  await page.getByRole("button", { name: "Show all notes" }).click();

  // A bad tag is refused with a reason.
  await adding.fill("2026");
  await adding.press("Enter");
  await expect(box.getByRole("alert")).toContainText("A tag can hold");

  // Edit as text brings the block into the editor and back.
  await box.getByRole("button", { name: "Edit as text" }).click();
  await expect(page.locator(".cm-content")).toContainText("title:");
  await expect(box).toHaveCount(0);
  await page.getByRole("button", { name: "Show as properties" }).click();
  await expect(page.locator(".cm-content")).not.toContainText("title:");
});

test("a chosen kind holds for every note after a restart and never rewrites them", async ({
  app,
}) => {
  const folder = app.folder("Kinds-");
  const first = join(folder, "First.md");
  const second = join(folder, "Second.md");
  writeFileSync(first, "---\ncount: 5\n---\nOne\n");
  writeFileSync(second, "---\ncount: many\n---\nTwo\n");

  let page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "First.md");

  const box = page.getByRole("region", { name: "Properties" });
  await box.getByRole("button", { name: "count: Number. Change kind" }).click();
  await page.getByRole("menuitem", { name: "Text" }).click();
  await expect(
    box.getByRole("button", { name: "count: Text. Change kind" }),
  ).toBeVisible();

  await box.getByRole("button", { name: "count: Text. Change kind" }).click();
  await page.getByRole("menuitem", { name: "Number" }).click();
  await openNote(page, "Second.md");
  await expect(box.getByText(/^Not a number\./)).toBeVisible();
  await expect(box.getByLabel("Value of property count")).toHaveValue("many");

  page = await app.launch();
  await openNotes(page);
  await openNote(page, "Second.md");
  await expect(
    page
      .getByRole("region", { name: "Properties" })
      .getByText(/^Not a number\./),
  ).toBeVisible();

  expect(readFileSync(first, "utf8")).toBe("---\ncount: 5\n---\nOne\n");
  expect(readFileSync(second, "utf8")).toBe("---\ncount: many\n---\nTwo\n");
});

test("a new property makes a block at the very start; broken YAML stays text", async ({
  app,
}) => {
  const folder = app.folder("Add-");
  const plain = join(folder, "Plain.md");
  const broken = join(folder, "Broken.md");
  const nested = join(folder, "Nested.md");
  writeFileSync(plain, "# Plain\n");
  writeFileSync(broken, "---\nbad: [unclosed\n---\nBody\n");
  writeFileSync(nested, "---\nmap:\n  a: 1\nok: yes please\n---\nBody\n");

  const page = await app.launch({ pick: folder });
  await addProject(page);
  await openNotes(page);
  await openNote(page, "Plain.md");

  const box = page.getByRole("region", { name: "Properties" });
  await box.getByRole("button", { name: "Add property" }).click();
  await box.getByLabel("Name of the new property").fill("due");
  await box.getByLabel("Kind of the new property").selectOption("date");
  await box.getByRole("button", { name: "Add", exact: true }).click();
  await expect(box.getByLabel("Value of property due")).toBeVisible();
  await expect
    .poll(() => readFileSync(plain, "utf8"))
    .toBe("---\ndue:\n---\n# Plain\n");
  await box.getByLabel("Value of property due").fill("2027-01-31");
  await box.getByLabel("Value of property due").press("Enter");
  await expect
    .poll(() => readFileSync(plain, "utf8"))
    .toBe("---\ndue: 2027-01-31\n---\n# Plain\n");

  await openNote(page, "Broken.md");
  await expect(
    page.getByText(/^This front matter cannot show as properties/),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("bad:");
  expect(readFileSync(broken, "utf8")).toBe("---\nbad: [unclosed\n---\nBody\n");

  await openNote(page, "Nested.md");
  await expect(box.getByText("a: 1")).toBeVisible();
  await expect(box.getByLabel("Value of property map")).toHaveCount(0);
  await box.getByLabel("Value of property ok").fill("no");
  await box.getByLabel("Value of property ok").press("Enter");
  await expect
    .poll(() => readFileSync(nested, "utf8"))
    .toBe('---\nmap:\n  a: 1\nok: "no"\n---\nBody\n');
});
