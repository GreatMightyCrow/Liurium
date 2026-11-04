import { expect, test } from "./app";

// M2-013: the release build stops WebView2's context menu and browser shortcuts.
// CDP cannot show the native menu or run browser shortcuts (ADR-0019), so this
// checks that the page refuses them; the native behavior is checked by hand.
test("the page refuses the browser's context menu and shortcuts", async ({
  app,
}) => {
  const page = await app.launch();
  // The app's own listeners must be in place before the test looks.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { seen });
    // Read once every listener has run, whatever their order.
    const record = (event: Event) => {
      const name = event instanceof KeyboardEvent ? event.key : event.type;
      setTimeout(() => {
        seen.push(`${name} ${event.defaultPrevented ? "blocked" : "allowed"}`);
      });
    };
    window.addEventListener("contextmenu", record);
    window.addEventListener("keydown", record);
  });
  const seen = () =>
    page.evaluate(() => (window as unknown as { seen: string[] }).seen);

  await page.getByRole("heading", { level: 1 }).click({ button: "right" });
  await page.keyboard.press("F5");
  await page.keyboard.press("Control+P");
  await page.keyboard.press("Control+Equal");

  // Playwright sends Control+P with the key "P". Ctrl + = is Liurium's own zoom
  // since M3-009, so the browser's default is stopped there too.
  await expect
    .poll(seen)
    .toEqual([
      "contextmenu blocked",
      "F5 blocked",
      "Control allowed",
      "P blocked",
      "Control allowed",
      "= blocked",
    ]);
});
