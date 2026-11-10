import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name })
    .click();

const column = (page: Page, name: string) => page.getByRole("region", { name });

const card = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title}`) });

const titles = (page: Page, name: string) =>
  column(page, name).getByRole("listitem").getByRole("button");

async function addTasks(page: Page, name: string, ...tasks: string[]) {
  await column(page, name).getByRole("button", { name: "Add task" }).click();
  const field = column(page, name).getByRole("textbox", { name: "Task title" });
  for (const task of tasks) {
    await field.fill(task);
    await field.press("Enter");
    await expect(card(page, task)).toBeVisible();
    await expect(field).toHaveValue("");
  }
  await field.press("Escape");
}

test("the board is exported to Markdown and a different file is replaced only on request", async ({
  app,
}) => {
  const folder = app.folder("Export-");
  const copy = join(app.folder("ExportOut-"), "Copy.md");
  const inProject = join(folder, "Tasks export.md");

  const page = await app.launch({ pick: folder, saveAs: copy });
  await nav(page, "Projects");
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await nav(page, "Tasks");
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
  await addTasks(page, "To do", "Roof");

  // By its name: a notification has the role of a dialog too.
  const dialog = page.getByRole("dialog", { name: /^(Export tasks|Replace)/ });
  const open = () => page.getByRole("button", { name: "Export…" }).click();
  const toast = page.getByText("Tasks exported");

  await open();
  await dialog.getByRole("button", { name: "Save in project" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toast).toBeVisible();
  expect(readFileSync(inProject, "utf8")).toContain("### Roof");

  // Changed by hand: left alone until the owner says so.
  writeFileSync(inProject, "my own words");
  await open();
  await dialog.getByRole("button", { name: "Save in project" }).click();
  await expect(dialog.getByRole("button", { name: "Replace" })).toBeVisible();
  expect(readFileSync(inProject, "utf8")).toBe("my own words");

  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(dialog).toHaveCount(0);
  expect(readFileSync(inProject, "utf8")).toContain("### Roof");
  expect(readdirSync(join(folder, ".liurium", "trash"))).toHaveLength(1);

  // The place comes from Rust; the Windows dialog stands in by a variable here.
  expect(existsSync(copy)).toBe(false);
  await open();
  await dialog.getByRole("button", { name: "Other place…" }).click();
  await expect(dialog).toHaveCount(0);
  expect(readFileSync(copy, "utf8")).toContain("### Roof");
});

test("filters narrow the board, a move keeps the hidden tasks' order, and nothing lasts", async ({
  app,
}) => {
  const folder = app.folder("Filter-");

  let page = await app.launch({ pick: folder });
  await nav(page, "Projects");
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await nav(page, "Tasks");
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
  await addTasks(page, "To do", "Roof one", "Door", "Roof two");

  await card(page, "Door").click();
  await page
    .getByRole("textbox", { name: "Description" })
    .fill("Ask the Größe");
  await page.getByRole("button", { name: "Close task" }).click();

  const text = page.getByRole("searchbox", { name: "Filter by text" });
  const count = page.getByRole("search").getByRole("status");

  // A word only in a description, in another case.
  await text.fill("GRÖßE");
  await expect(titles(page, "To do")).toHaveCount(1);
  await expect(card(page, "Door")).toBeVisible();
  await expect(count).toHaveText("1 of 3 tasks");

  // The hidden Door stays between the two.
  await text.fill("roof");
  await expect(titles(page, "To do")).toHaveText(["Roof one", "Roof two"]);
  await card(page, "Roof two").focus();
  await page.keyboard.press("Control+ArrowUp");
  await expect(titles(page, "To do")).toHaveText(["Roof two", "Roof one"]);

  // It stays across pages.
  await nav(page, "Settings");
  await nav(page, "Tasks");
  await expect(
    page.getByRole("searchbox", { name: "Filter by text" }),
  ).toHaveValue("roof");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(titles(page, "To do")).toHaveText([
    "Roof two",
    "Roof one",
    "Door",
  ]);

  // Not after a restart.
  await page.getByRole("searchbox", { name: "Filter by text" }).fill("door");
  page = await app.launch();
  await nav(page, "Tasks");
  await expect(
    page.getByRole("searchbox", { name: "Filter by text" }),
  ).toHaveValue("");
  await expect(titles(page, "To do")).toHaveCount(3);
});

test("tasks are added, dragged, moved by keys, edited, trashed, and still there after a restart", async ({
  app,
}) => {
  const folder = app.folder("Board-");
  writeFileSync(join(folder, "Plan.md"), "A note.\n");

  let page = await app.launch({ pick: folder });
  await nav(page, "Projects");
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await nav(page, "Tasks");
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();

  await addTasks(page, "To do", "Alpha", "Beta", "Gamma");
  await expect(titles(page, "To do")).toHaveText(["Alpha", "Beta", "Gamma"]);

  // With a real pointer, into another column.
  const from = await card(page, "Beta").boundingBox();
  const to = await column(page, "Doing").boundingBox();
  if (from === null || to === null) {
    throw new Error("no layout");
  }
  await page.mouse.move(from.x + 30, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + 20, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect(titles(page, "Doing")).toHaveText(["Beta"]);
  await expect(titles(page, "To do")).toHaveText(["Alpha", "Gamma"]);
  // A drag does not open the task.
  await expect(page.getByRole("region", { name: "Task" })).toHaveCount(0);

  // By keys; the card keeps the focus.
  await card(page, "Alpha").focus();
  await page.keyboard.press("Control+ArrowDown");
  await expect(titles(page, "To do")).toHaveText(["Gamma", "Alpha"]);
  await expect(card(page, "Alpha")).toBeFocused();

  // Edits save without a button; closing saves what is still waiting.
  await card(page, "Gamma").click();
  await page.getByRole("textbox", { name: "Description" }).fill("Some text");
  await page.getByRole("radio", { name: "High" }).click();
  await page.getByRole("textbox", { name: "Add tag" }).fill("garden");
  await page.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await page.getByRole("textbox", { name: "Link a note" }).fill("plan");
  await page
    .getByRole("list", { name: "Matching notes" })
    .getByRole("button", { name: "Plan.md" })
    .click();
  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page.getByRole("region", { name: "Task" })).toHaveCount(0);
  await expect(card(page, "Gamma")).toContainText("Priority: High");
  await expect(card(page, "Gamma")).toContainText("#garden");

  // Into the trash and out again.
  await card(page, "Alpha").click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(titles(page, "To do")).toHaveText([/^Gamma/]);
  await page.getByRole("button", { name: "Trash (1)" }).click();
  const trash = page.getByRole("region", { name: "Trash" });
  await expect(trash.getByText("Alpha")).toBeVisible();
  await trash.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Trash (0)" })).toBeVisible();
  await expect(titles(page, "To do")).toHaveText([/^Gamma/, "Alpha"]);

  // A column of the project's own, and no page wider than the window.
  await page.getByRole("button", { name: "Add column" }).click();
  const name = page.getByRole("textbox", { name: "Column name" });
  await name.fill("Review");
  await name.press("Enter");
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await card(page, "Gamma").click();
  await expect(page.getByRole("region", { name: "Task" })).toBeVisible();
  expect(
    await page.evaluate(() => document.querySelector("main")?.scrollLeft),
  ).toBe(0);
  await page.getByRole("button", { name: "Close task" }).click();

  page = await app.launch();
  await nav(page, "Tasks");
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(titles(page, "To do")).toHaveText([/^Gamma/, "Alpha"]);
  await expect(titles(page, "Doing")).toHaveText(["Beta"]);
  await card(page, "Gamma").click();
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Some text",
  );
  await expect(
    page.getByRole("button", { name: "Plan.md", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "High" })).toBeChecked();
});
