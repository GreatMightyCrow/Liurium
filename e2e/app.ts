import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test as base, type Page } from "@playwright/test";

// End-to-end tests drive the release build over the Chrome DevTools Protocol
// (ADR-0019). WebView2 opens the port only when the environment variable asks
// for it; the app itself has no test hook.
const APP = resolve(
  import.meta.dirname,
  "../src-tauri/target/release/liurium.exe",
);
const PORT = 9333;
const ENDPOINT = `http://127.0.0.1:${String(PORT)}`;

async function endpointUp(): Promise<boolean> {
  try {
    return (await fetch(`${ENDPOINT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function until(
  check: () => Promise<boolean>,
  what: string,
  ms: number,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const test = base.extend<{ app: Page }>({
  app: async ({ playwright }, use) => {
    if (!existsSync(APP)) {
      throw new Error(`build the app first (pnpm tauri build --no-bundle)`);
    }
    // A browser left over from an earlier run would answer on the same port,
    // and the test would drive the wrong app.
    if (await endpointUp()) {
      throw new Error(`port ${String(PORT)} is already in use`);
    }
    const app = spawn(APP, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(PORT)}`,
      },
      stdio: "ignore",
    });
    const exited = new Promise<void>((done) => {
      app.once("exit", () => {
        done();
      });
    });
    try {
      await until(endpointUp, "the debugging port", 15_000);
      const browser = await playwright.chromium.connectOverCDP(ENDPOINT);
      const page = browser.contexts().at(0)?.pages().at(0);
      if (page === undefined) {
        throw new Error("the app has no page");
      }
      await use(page);
      // Close through the app's own button so storage shuts down cleanly.
      await page
        .getByRole("button", { name: "Close" })
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await browser.close();
      await Promise.race([exited, sleep(5_000)]);
    } finally {
      // Kills the whole tree; WebView2's browser processes otherwise keep the
      // port open for a moment after the app is gone.
      if (
        app.pid !== undefined &&
        app.exitCode === null &&
        app.signalCode === null
      ) {
        execFileSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      }
      await until(
        async () => !(await endpointUp()),
        "the debugging port to close",
        10_000,
      );
    }
  },
});

export { expect } from "@playwright/test";
