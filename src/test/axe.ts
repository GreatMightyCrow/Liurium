import axe from "axe-core";
import indexHtml from "../../index.html?raw";

// jsdom has no layout, so axe cannot compute contrast here; the release-build
// check covers it, and tokens.test.ts checks the token pairs.
const options: axe.RunOptions = {
  rules: { "color-contrast": { enabled: false } },
};

// axe treats an open dialog as its own region, so its portal sits outside the page
// landmarks without a finding. An open menu is just as transient and takes focus the
// same way; extend axe's default list (axe-core 4.14.0) by menus instead of
// switching the region rule off.
axe.configure({
  checks: [
    {
      id: "region",
      options: {
        regionMatcher:
          "dialog, [role=dialog], [role=alertdialog], svg, [role=menu]",
      },
    },
  ],
});

// The test document is empty; give it the language and title of the real index.html.
const page = new DOMParser().parseFromString(indexHtml, "text/html");

/** Runs axe over the whole document; one line per violation, empty when clean. */
export async function axeViolations(): Promise<string[]> {
  document.documentElement.lang = page.documentElement.lang;
  document.title = page.title;
  const results = await axe.run(document, options);
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} at ${violation.nodes
        .map((node) => JSON.stringify(node.target))
        .join(", ")}`,
  );
}
