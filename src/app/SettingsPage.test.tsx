import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  type AppDataInfo,
  type AppInfo,
  getAppDataInfo,
  getAppInfo,
  getSettings,
  openAppDataFolder,
  pruneBackups,
  resetSyncWarnings,
  restartApp,
  type SettingsView,
  updateSettings,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { SettingsPage, sizeText } from "./SettingsPage";
import { SettingsProvider } from "./settingsState";

vi.mock("../lib/ipc/commands", () => ({
  getAppInfo: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  restartApp: vi.fn(),
  getAppDataInfo: vi.fn(),
  openAppDataFolder: vi.fn(),
  pruneBackups: vi.fn(),
  resetSyncWarnings: vi.fn(),
}));

const mocks = {
  info: vi.mocked(getAppInfo),
  get: vi.mocked(getSettings),
  update: vi.mocked(updateSettings),
  restart: vi.mocked(restartApp),
  data: vi.mocked(getAppDataInfo),
  openFolder: vi.mocked(openAppDataFolder),
  prune: vi.mocked(pruneBackups),
  reset: vi.mocked(resetSyncWarnings),
};

const defaults: SettingsView = {
  settings: {
    theme: "orange",
    mode: "system",
    frame: "liurium",
    startup: "lastProject",
    zoom: 100,
  },
  frameAtStart: "liurium",
  fellBack: [],
  zoomSteps: [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200],
};

const appData: AppDataInfo = {
  folder: String.raw`C:\Users\you\AppData\Local\io.github.greatmightycrow.liurium`,
  backups: 5,
  backupBytes: 1_468_006,
  keptBackups: 3,
  syncWarned: 2,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.info.mockResolvedValue({ version: "0.1.0", data: { state: "ready" } });
  mocks.get.mockResolvedValue(defaults);
  mocks.data.mockResolvedValue(appData);
  document.documentElement.dataset.accent = "orange";
  document.documentElement.dataset.base = "warm";
  document.documentElement.dataset.mode = "dark";
});

function Where() {
  const [location] = useLocation();
  return <span data-testid="location">{location}</span>;
}

function show(children: ReactNode = <SettingsPage />, path = "/settings") {
  const { hook } = memoryLocation({ path });
  render(
    <Router hook={hook}>
      <SettingsProvider>
        {children}
        <Where />
      </SettingsProvider>
    </Router>,
  );
}

function section(name: string) {
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("button", { name }),
  );
}

/** Rust answers an update with what it saved. */
function saving() {
  mocks.update.mockImplementation((settings) =>
    Promise.resolve({ ...defaults, settings }),
  );
}

function chosen(name: string): string | null {
  return screen.getByRole("radio", { name }).getAttribute("aria-checked");
}

test("the sections are listed and Appearance comes first", async () => {
  show();

  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Appearance", "Startup", "Data", "About"]);
  expect(
    within(nav)
      .getByRole("button", { name: "Appearance" })
      .getAttribute("aria-current"),
  ).toBe("true");
  expect(
    await screen.findByRole("heading", { level: 2, name: "Appearance" }),
  ).toBeDefined();

  section("About");
  expect(
    await screen.findByRole("heading", { level: 2, name: "About Liurium" }),
  ).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
  expect(
    within(nav)
      .getByRole("button", { name: "About" })
      .getAttribute("aria-current"),
  ).toBe("true");
});

test("About shows the version, the data status, and the license", async () => {
  mocks.info.mockResolvedValue({ version: "0.1.0", data: { state: "ready" } });
  show();
  section("About");

  expect(await screen.findByText("0.1.0")).toBeDefined();
  expect(screen.getByText("Ready")).toBeDefined();
  expect(screen.getByText("GPL-3.0-only")).toBeDefined();
});

test.each<[string, AppInfo, RegExp]>([
  [
    "replaced app data",
    { version: "0.1.0", data: { state: "recovered" } },
    /app data was damaged and has been replaced/,
  ],
  [
    "app data that could not be opened",
    {
      version: "0.1.0",
      data: { state: "failed", error: { kind: "newerVersion" } },
    },
    /made by a newer version of Liurium/,
  ],
])("About explains %s", async (_name, info, text) => {
  mocks.info.mockResolvedValue(info);
  show();
  section("About");

  expect(await screen.findByText(text)).toBeDefined();
});

test("app information that cannot be loaded shows why", async () => {
  mocks.info.mockRejectedValue(
    new CommandFailure("app_info", { kind: "locked" }),
  );
  show();
  section("About");

  const alert = await screen.findByText(/App information could not be loaded/);
  expect(alert.closest("[role=alert]")?.textContent).toContain(
    "Another program is using this data",
  );
});

test("shows the stored theme, mode, and window frame as chosen pictures", async () => {
  mocks.get.mockResolvedValue({
    ...defaults,
    settings: {
      ...defaults.settings,
      theme: "mint-graphite",
      mode: "dark",
      frame: "native",
    },
    frameAtStart: "native",
  });
  show();

  expect(
    await screen.findByRole("radiogroup", { name: "Theme" }),
  ).toBeDefined();
  expect(chosen("Mint on graphite")).toBe("true");
  expect(chosen("Orange")).toBe("false");
  expect(chosen("Dark")).toBe("true");
  expect(chosen("Windows title bar")).toBe("true");
  expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
});

test("each theme picture uses that theme's own colors", async () => {
  show();
  const mint = await screen.findByRole("radio", { name: "Mint on graphite" });

  const picture = mint.querySelector("[data-preview]");
  expect(picture?.getAttribute("data-accent")).toBe("mint");
  expect(picture?.getAttribute("data-base")).toBe("graphite");
  expect(picture?.getAttribute("data-mode")).toBe("dark");
  // "Same as Windows" shows both modes.
  const system = screen.getByRole("radio", { name: "Same as Windows" });
  expect(
    Array.from(system.querySelectorAll("[data-preview]"), (element) =>
      element.getAttribute("data-mode"),
    ),
  ).toEqual(["light", "dark"]);
});

test("a new theme is saved, then shown at once", async () => {
  saving();
  show();

  fireEvent.click(await screen.findByRole("radio", { name: "Mint" }));

  expect(mocks.update).toHaveBeenCalledWith({
    ...defaults.settings,
    theme: "mint",
  });
  await waitFor(() => {
    expect(document.documentElement.dataset.accent).toBe("mint");
  });
  expect(document.documentElement.dataset.base).toBe("cool");
  expect(chosen("Mint")).toBe("true");
});

test("a new mode is saved with the other settings unchanged", async () => {
  saving();
  show();

  fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

  expect(mocks.update).toHaveBeenCalledWith({
    ...defaults.settings,
    mode: "light",
  });
  await waitFor(() => {
    expect(chosen("Light")).toBe("true");
  });
  expect(document.documentElement.dataset.accent).toBe("orange");
});

test("a new window frame offers a restart", async () => {
  saving();
  mocks.restart.mockResolvedValue(undefined);
  show();

  fireEvent.click(await screen.findByRole("radio", { name: "No title bar" }));

  expect(
    await screen.findByText(
      "The new window frame applies after Liurium restarts.",
    ),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
  expect(mocks.restart).toHaveBeenCalledOnce();
  expect(
    screen
      .getByRole("button", { name: "Restarting…" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("choosing the frame Liurium started with needs no restart", async () => {
  saving();
  mocks.get.mockResolvedValue({
    ...defaults,
    settings: { ...defaults.settings, frame: "hidden" },
  });
  show();

  expect(
    await screen.findByRole("button", { name: "Restart now" }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("radio", { name: "Liurium title bar" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
  });
});

test("a change that cannot be saved goes back and says why", async () => {
  mocks.update.mockRejectedValue(
    new CommandFailure("update_settings", { kind: "readOnly" }),
  );
  show();

  fireEvent.click(await screen.findByRole("radio", { name: "Mint" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "The change could not be saved. This file or folder is write-protected. Nothing was changed.",
  );
  expect(chosen("Orange")).toBe("true");
  expect(document.documentElement.dataset.accent).toBe("orange");
});

test("only the answer to the latest change counts", async () => {
  const answers: ((view: SettingsView) => void)[] = [];
  mocks.update.mockImplementation(
    () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  );
  show();

  fireEvent.click(await screen.findByRole("radio", { name: "Mint" }));
  fireEvent.click(screen.getByRole("radio", { name: "Orange on graphite" }));
  expect(answers).toHaveLength(2);
  const [first, second] = answers;
  // The later change answers first; the earlier answer must not undo it.
  second({
    ...defaults,
    settings: { ...defaults.settings, theme: "orange-graphite" },
  });
  first({ ...defaults, settings: { ...defaults.settings, theme: "mint" } });

  await waitFor(() => {
    expect(document.documentElement.dataset.base).toBe("graphite");
  });
  expect(document.documentElement.dataset.accent).toBe("orange");
  expect(chosen("Orange on graphite")).toBe("true");
});

test("says which saved values could not be read", async () => {
  mocks.get.mockResolvedValue({ ...defaults, fellBack: ["theme", "zoom"] });
  show();

  expect(
    await screen.findByText(
      "Liurium could not read the saved theme and zoom and uses the default. Choose again to save it.",
    ),
  ).toBeDefined();
});

test("settings that cannot be loaded show why", async () => {
  mocks.get.mockRejectedValue(
    new CommandFailure("get_settings", { kind: "internal" }),
  );
  show();

  expect(await screen.findByText("Settings could not be loaded")).toBeDefined();
});

test("zoom buttons save the next step; the ends and 100 % disable their button", async () => {
  saving();
  show();
  const zoom = await screen.findByRole("status", { name: "Zoom" });
  expect(zoom.textContent).toBe("100 %");
  expect(
    screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled"),
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

  expect(mocks.update).toHaveBeenLastCalledWith({
    ...defaults.settings,
    zoom: 110,
  });
  await waitFor(() => {
    expect(zoom.textContent).toBe("110 %");
  });
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(mocks.update).toHaveBeenLastCalledWith({
    ...defaults.settings,
    zoom: 100,
  });
});

test("the largest zoom cannot grow", async () => {
  mocks.get.mockResolvedValue({
    ...defaults,
    settings: { ...defaults.settings, zoom: 200 },
  });
  show();

  const larger = await screen.findByRole("button", { name: "Zoom in" });
  expect(larger.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("Ctrl + Plus and Ctrl + wheel zoom on every page, not only in Settings", async () => {
  saving();
  show(<p>Another page</p>);
  await waitFor(() => {
    expect(mocks.get).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });

  fireEvent.keyDown(window, { key: "+", ctrlKey: true });
  expect(mocks.update).toHaveBeenLastCalledWith({
    ...defaults.settings,
    zoom: 110,
  });
  await waitFor(() => {
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  fireEvent.keyDown(window, { key: "0", ctrlKey: true });
  expect(mocks.update).toHaveBeenLastCalledWith({
    ...defaults.settings,
    zoom: 100,
  });
});

test("the startup choice is saved and says when it applies", async () => {
  saving();
  show();
  section("Startup");

  expect(await screen.findByText("Applies at the next start.")).toBeDefined();
  expect(chosen("Open the last project")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Show the project list" }));

  expect(mocks.update).toHaveBeenCalledWith({
    ...defaults.settings,
    startup: "projectList",
  });
});

test("with the project list at start, the app opens on Projects", async () => {
  mocks.get.mockResolvedValue({
    ...defaults,
    settings: { ...defaults.settings, startup: "projectList" },
  });
  show(null, "/");

  await waitFor(() => {
    expect(screen.getByTestId("location").textContent).toBe("/projects");
  });
});

test("with the last project at start, the app stays where it is", async () => {
  show(null, "/");

  await waitFor(() => {
    expect(mocks.get).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId("location").textContent).toBe("/");
});

test("Data names the folder, the backups, and the sync warnings", async () => {
  show();
  section("Data");

  expect(await screen.findByText(appData.folder)).toBeDefined();
  expect(
    screen.getByText(
      "5 copies, 1.4 MB. Liurium makes one before it updates its data; the newest 3 always stay.",
    ),
  ).toBeDefined();
  expect(
    screen.getByText(
      "Shown once for each project in a OneDrive or Dropbox folder. 2 projects have shown it.",
    ),
  ).toBeDefined();
});

test("Open folder asks Rust to open it and sends nothing", async () => {
  mocks.openFolder.mockResolvedValue(undefined);
  show();
  section("Data");

  fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));

  expect(mocks.openFolder).toHaveBeenCalledWith();
});

test("deleting older backups asks first and reports what was deleted", async () => {
  mocks.prune.mockResolvedValue({ ...appData, backups: 3, backupBytes: 900 });
  show();
  section("Data");

  fireEvent.click(
    await screen.findByRole("button", { name: "Delete 2 older copies…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Delete 2 older backup copies?",
  });
  expect(dialog.textContent).toContain(
    "The newest 3 copies stay. Your projects and notes are not affected.",
  );
  expect(mocks.prune).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

  expect(mocks.prune).toHaveBeenCalledOnce();
  expect(await screen.findByText("Deleted 2 copies.")).toBeDefined();
  expect(screen.queryByRole("button", { name: /older cop/ })).toBeNull();
});

test("cancelling the question deletes nothing", async () => {
  show();
  section("Data");

  fireEvent.click(
    await screen.findByRole("button", { name: "Delete 2 older copies…" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(mocks.prune).not.toHaveBeenCalled();
});

test("with three copies or fewer there is nothing to delete", async () => {
  mocks.data.mockResolvedValue({ ...appData, backups: 3 });
  show();
  section("Data");

  await screen.findByText(appData.folder);
  expect(screen.queryByRole("button", { name: /older cop/ })).toBeNull();
});

test("Warn again resets the warnings and says what happens", async () => {
  mocks.reset.mockResolvedValue({ ...appData, syncWarned: 0 });
  show();
  section("Data");

  fireEvent.click(await screen.findByRole("button", { name: "Warn again" }));

  expect(
    await screen.findByText("Each project warns again the next time it opens."),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Warn again" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("a failed data action says why", async () => {
  mocks.openFolder.mockRejectedValue(
    new CommandFailure("open_app_data_folder", { kind: "notFound" }),
  );
  show();
  section("Data");

  fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "The folder could not be opened. The file or folder no longer exists.",
  );
});

test("app data that cannot be read shows why", async () => {
  mocks.data.mockRejectedValue(
    new CommandFailure("app_data_info", { kind: "newerVersion" }),
  );
  show();
  section("Data");

  expect(await screen.findByText("App data could not be read")).toBeDefined();
});

test.each([
  [0, "0 bytes"],
  [1023, "1023 bytes"],
  [2048, "2 KB"],
  [1_468_006, "1.4 MB"],
])("%i bytes read as %s", (bytes, text) => {
  expect(sizeText(bytes)).toBe(text);
});
