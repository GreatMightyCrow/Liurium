import { readdirSync } from "node:fs";
import { expect, test } from "./app";

// One Liurium per user (ADR-0016, M2-010): a second start brings the running
// window back and ends. It ignores its arguments and never opens app data.
test("a second start brings the running window back and opens nothing itself", async ({
  app,
}) => {
  const page = await app.launch();
  // On a cold start the page can still navigate to the app after the port opens.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const loadedAt = await page.evaluate(() => performance.timeOrigin);
  await expect.poll(() => app.window().minimized).toBe(false);
  await page.getByRole("button", { name: "Minimize" }).click();
  await expect.poll(() => app.window().minimized).toBe(true);

  const otherData = app.folder("liurium-e2e-second-");
  const code = await app.startAgain(otherData, [
    "--open",
    "..\\..\\Windows",
    "liurium://projects",
  ]);

  expect(code).toBe(0);
  await expect
    .poll(() => app.window())
    .toEqual({ minimized: false, foreground: true });
  expect(page.context().pages()).toHaveLength(1);
  // The same page as before, not a reload.
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  expect(readdirSync(otherData)).toEqual([]);
});
