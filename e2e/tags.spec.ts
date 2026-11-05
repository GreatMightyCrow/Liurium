import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./app";

function write(folder: string, rel: string, text: string) {
  const path = join(folder, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("a tag typed in a note shows in the Tags view and filters the tree; an alias link opens its note", async ({
  app,
}) => {
  const folder = app.folder("Tags-");
  write(folder, "Home.md", "See [[Roadmap]].\n\n#garden\n");
  write(
    folder,
    "Deep/Plan.md",
    "---\ntags: [garden/roses]\naliases: [Roadmap]\n---\n\n# Plan\n",
  );
  write(folder, "Other.md", "No tags, and `#code` is none.\n");

  const page = await app.launch({ pick: folder });
  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await primary.getByRole("link", { name: "Notes" }).click();

  const tree = page.getByRole("navigation", { name: "Notes in this project" });
  await tree.getByRole("link", { name: "Home.md" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Home.md", exact: true }),
  ).toBeVisible();

  // Colored in the text, listed in the header.
  await expect(page.locator(".cm-tag")).toHaveText("#garden");
  const headerTags = page.getByRole("list", { name: "Tags" });
  await expect(headerTags.getByRole("button")).toHaveText(["#garden"]);

  // The alias resolves like a name: found, and followed with Ctrl + click.
  await page.locator(".cm-link-note").click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("heading", { level: 2, name: "Plan.md", exact: true }),
  ).toBeVisible();
  // Its front matter tags show in the properties box instead of the header.
  await expect(
    page
      .getByRole("region", { name: "Properties" })
      .getByRole("button", { name: "garden/roses", exact: true }),
  ).toBeVisible();
  await expect(headerTags).toHaveCount(0);

  // A tag typed just now counts at once: the Tags tab saves the note first.
  await tree.getByRole("link", { name: "Other.md" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Other.md", exact: true }),
  ).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n#fresh ");
  await page.getByRole("tab", { name: "Tags" }).click();

  const panel = page.getByRole("tabpanel", { name: "Tags" });
  await expect(panel.getByRole("button")).toHaveText([
    /^#fresh\s*1\s*note$/,
    /^#garden\s*2\s*notes$/,
    /^#garden\/roses\s*1\s*note$/,
  ]);

  // Choosing #garden keeps #garden/roses too, with its folder open.
  await panel.getByRole("button", { name: "#garden 2 notes" }).click();
  await expect(page.getByText("Showing notes tagged #garden")).toBeVisible();
  await expect(page.getByText("2 of 3 notes")).toBeVisible();
  await expect(tree.getByRole("link", { name: "Plan.md" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "Home.md" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "Other.md" })).toHaveCount(0);

  await page.getByRole("button", { name: "Show all notes" }).click();
  await expect(tree.getByRole("link", { name: "Other.md" })).toBeVisible();

  // A tag in the header filters too.
  await expect(headerTags.getByRole("button")).toHaveText(["#fresh"]);
  await headerTags.getByRole("button", { name: "#fresh" }).click();
  await expect(page.getByText("Showing notes tagged #fresh")).toBeVisible();
  await expect(tree.getByRole("link", { name: "Home.md" })).toHaveCount(0);
});
