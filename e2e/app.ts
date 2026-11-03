import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Browser,
  test as base,
  type Page,
  type PlaywrightWorkerArgs,
} from "@playwright/test";

// End-to-end tests drive the end-to-end build over the Chrome DevTools Protocol
// (ADR-0019). WebView2 opens the port only when the environment variable asks
// for it. The build has the Cargo feature `e2e`, which lets a test choose the app
// data folder and the folder that "Add project folder" takes (M2-005); the
// normal build has neither.
const APP = resolve(
  import.meta.dirname,
  "../src-tauri/target/e2e/release/liurium.exe",
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

/** Removed only after the app has stopped; WebView2 may hold files a moment longer. */
function removeFolder(folder: string): void {
  rmSync(folder, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

/** A new empty folder, with its long path (CI's temp path is a short 8.3 name). */
function tempFolder(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

interface LaunchOptions {
  /** The folder "Add project folder" takes instead of showing the dialog. */
  pick?: string;
  /** A folder the app treats as OneDrive's (M2-010); real sync folders are ignored. */
  oneDrive?: string;
}

interface Running {
  process: ChildProcess;
  browser: Browser;
  page: Page;
  /** The window's handle, taken the first time a test asks about the window. */
  window?: string;
}

async function start(
  playwright: PlaywrightWorkerArgs["playwright"],
  dataDir: string,
  options: LaunchOptions,
): Promise<Running> {
  if (!existsSync(APP)) {
    throw new Error("build the app first (pnpm e2e:build)");
  }
  // A browser left over from an earlier run would answer on the same port, and
  // the test would drive the wrong app.
  if (await endpointUp()) {
    throw new Error(`port ${String(PORT)} is already in use`);
  }
  const app = spawn(APP, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(PORT)}`,
      LIURIUM_E2E_DATA_DIR: dataDir,
      ...(options.pick === undefined ? {} : { LIURIUM_E2E_PICK: options.pick }),
      ...(options.oneDrive === undefined
        ? {}
        : { LIURIUM_E2E_ONEDRIVE: options.oneDrive }),
    },
    stdio: "ignore",
  });
  try {
    // The first WebView2 start on a fresh machine (CI) can take a while.
    await until(
      async () => {
        if (app.exitCode !== null || app.signalCode !== null) {
          throw new Error(
            `the app exited (code ${String(app.exitCode)}) before opening the debugging port`,
          );
        }
        return endpointUp();
      },
      "the debugging port",
      60_000,
    );
    const browser = await playwright.chromium.connectOverCDP(ENDPOINT);
    const context = browser.contexts().at(0);
    if (context === undefined) {
      throw new Error("the app has no browser context");
    }
    // The port can open before WebView2 has created the page (seen on CI).
    const page = context.pages().at(0) ?? (await context.waitForEvent("page"));
    // Playwright pretends a light color scheme by default; the tests need the
    // window's real mode (M2-007).
    await page.emulateMedia({ colorScheme: null });
    return { process: app, browser, page };
  } catch (error) {
    await kill(app);
    throw error;
  }
}

async function stop({ process: app, browser, page }: Running): Promise<void> {
  const exited = new Promise<void>((done) => {
    if (app.exitCode !== null || app.signalCode !== null) {
      done();
    }
    app.once("exit", () => {
      done();
    });
  });
  // Close through the app's own button so storage shuts down cleanly.
  await page
    .getByRole("button", { name: "Close" })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
  await browser.close();
  await Promise.race([exited, sleep(5_000)]);
  await kill(app);
}

// Kills the whole tree; WebView2's browser processes otherwise keep the port
// open for a moment after the app is gone.
async function kill(app: ChildProcess): Promise<void> {
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

export interface WindowState {
  minimized: boolean;
  foreground: boolean;
}

function powershell(script: string): string {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).trim();
}

// The handle of the app's window while it is shown. Windows' "main window" of a
// process changes to another of its windows once this one is minimized.
function mainWindow(pid: number): string {
  const handle = powershell(
    `(Get-Process -Id ${String(pid)}).MainWindowHandle.ToInt64()`,
  );
  if (!/^[1-9]\d*$/.test(handle)) {
    throw new Error(`the app has no window yet (${handle})`);
  }
  return handle;
}

// WebView2 keeps reporting the page as visible while the window is minimized, so
// the window itself is asked through Windows (read-only calls).
function windowState(handle: string): WindowState {
  const [minimized, foreground] = powershell(
    [
      "Add-Type -Namespace Liurium -Name Win -MemberDefinition '",
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);',
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      "'",
      `$window = [IntPtr]${handle}`,
      "'{0} {1}' -f [Liurium.Win]::IsIconic($window), ([Liurium.Win]::GetForegroundWindow() -eq $window)",
    ].join("\n"),
  ).split(" ");
  return { minimized: minimized === "True", foreground: foreground === "True" };
}

/** A second start without a debugging port: it should hand over and exit. */
async function startAgain(
  dataDir: string,
  args: string[],
): Promise<number | null> {
  const second = spawn(APP, args, {
    env: { ...process.env, LIURIUM_E2E_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((done) => {
    second.once("exit", (code) => {
      done(code);
    });
  });
  const code = await Promise.race([exited, sleep(15_000, "running" as const)]);
  if (code === "running") {
    // Not `kill`: the debugging port belongs to the first app and stays open.
    execFileSync("taskkill", ["/pid", String(second.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    throw new Error("the second start kept running");
  }
  return code;
}

interface App {
  /**
   * Starts the app and returns its page; calling it again restarts the app
   * with the same data folder.
   */
  launch: (options?: LaunchOptions) => Promise<Page>;
  /** Stops the app, e.g. to move a project folder while nothing holds it. */
  stop: () => Promise<void>;
  /**
   * Starts the app once more while it runs, with its own data folder and
   * arguments, and resolves with that start's exit code (M2-010).
   */
  startAgain: (dataDir: string, args: string[]) => Promise<number | null>;
  /**
   * Whether the running app's window is minimized and in front. Ask once while
   * the window is shown, so the right window is remembered.
   */
  window: () => WindowState;
  /** A new empty folder, removed after the app has stopped. */
  folder: (prefix: string) => string;
}

/**
 * Each test gets a fresh app data folder, so tests never touch the user's own
 * data. At the end the app stops first, then the test's folders are removed.
 */
export const test = base.extend<{ app: App }>({
  app: async ({ playwright }, use) => {
    const folders = [tempFolder("liurium-e2e-data-")];
    const dataDir = folders[0] ?? "";
    let running: Running | undefined;
    try {
      await use({
        launch: async (options = {}) => {
          if (running !== undefined) {
            await stop(running);
            running = undefined;
          }
          running = await start(playwright, dataDir, options);
          return running.page;
        },
        stop: async () => {
          if (running !== undefined) {
            await stop(running);
            running = undefined;
          }
        },
        startAgain: (otherDataDir, args) => startAgain(otherDataDir, args),
        window: () => {
          if (running?.process.pid === undefined) {
            throw new Error("the app is not running");
          }
          running.window ??= mainWindow(running.process.pid);
          return windowState(running.window);
        },
        folder: (prefix) => {
          const folder = tempFolder(prefix);
          folders.push(folder);
          return folder;
        },
      });
    } finally {
      if (running !== undefined) {
        await stop(running);
      }
      for (const folder of folders) {
        removeFolder(folder);
      }
    }
  },
});
export { expect } from "@playwright/test";
