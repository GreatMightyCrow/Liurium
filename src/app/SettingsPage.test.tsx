import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type AppInfo,
  getAppInfo,
  getSettings,
  restartApp,
  type SettingsView,
  updateSettings,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/ipc/commands", () => ({
  getAppInfo: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  restartApp: vi.fn(),
}));

const mocks = {
  info: vi.mocked(getAppInfo),
  get: vi.mocked(getSettings),
  update: vi.mocked(updateSettings),
  restart: vi.mocked(restartApp),
};

const defaults: SettingsView = {
  settings: { theme: "orange", mode: "system", frame: "liurium" },
  frameAtStart: "liurium",
  fellBack: [],
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.info.mockResolvedValue({ version: "0.1.0", data: { state: "ready" } });
  mocks.get.mockResolvedValue(defaults);
  document.documentElement.dataset.accent = "orange";
  document.documentElement.dataset.base = "warm";
});

function showWith(info: AppInfo) {
  mocks.info.mockResolvedValue(info);
  render(<SettingsPage />);
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

test("shows a loading state, then the version and the data status", async () => {
  showWith({ version: "0.1.0", data: { state: "ready" } });

  expect(
    screen.getAllByRole("status").map((status) => status.textContent),
  ).toEqual(["Loading settings…", "Loading app information…"]);
  expect(await screen.findByText("0.1.0")).toBeDefined();
  expect(screen.getByText("Ready")).toBeDefined();
  expect(screen.getByRole("heading", { name: "About Liurium" })).toBeDefined();
});

test("explains replaced app data", async () => {
  showWith({ version: "0.1.0", data: { state: "recovered" } });

  expect(
    await screen.findByText(/app data was damaged and has been replaced/),
  ).toBeDefined();
});

test("explains app data that could not be opened", async () => {
  showWith({
    version: "0.1.0",
    data: { state: "failed", error: { kind: "newerVersion" } },
  });

  expect(
    await screen.findByText(/made by a newer version of Liurium/),
  ).toBeDefined();
});

test("a failed command shows an error state with a plain message", async () => {
  mocks.info.mockRejectedValue(
    new CommandFailure("app_info", { kind: "locked" }),
  );
  render(<SettingsPage />);

  const alert = await screen.findByText(/App information could not be loaded/);
  expect(alert.closest("[role=alert]")?.textContent).toContain(
    "Another program is using this data",
  );
});

test("shows the stored theme, mode, and window frame", async () => {
  mocks.get.mockResolvedValue({
    ...defaults,
    settings: { theme: "mint-graphite", mode: "dark", frame: "native" },
    frameAtStart: "native",
  });
  render(<SettingsPage />);

  expect(
    await screen.findByRole("radiogroup", { name: "Theme" }),
  ).toBeDefined();
  expect(chosen("Mint on graphite")).toBe("true");
  expect(chosen("Dark")).toBe("true");
  expect(chosen("Windows title bar")).toBe("true");
  expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
});

test("a new theme is saved, then shown at once", async () => {
  saving();
  render(<SettingsPage />);

  fireEvent.click(await screen.findByRole("radio", { name: "Mint" }));

  expect(mocks.update).toHaveBeenCalledWith({
    theme: "mint",
    mode: "system",
    frame: "liurium",
  });
  await waitFor(() => {
    expect(document.documentElement.dataset.accent).toBe("mint");
  });
  expect(document.documentElement.dataset.base).toBe("cool");
  expect(chosen("Mint")).toBe("true");
});

test("a new mode is saved with the other settings unchanged", async () => {
  saving();
  render(<SettingsPage />);

  fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

  expect(mocks.update).toHaveBeenCalledWith({
    theme: "orange",
    mode: "light",
    frame: "liurium",
  });
  await waitFor(() => {
    expect(chosen("Light")).toBe("true");
  });
  expect(document.documentElement.dataset.accent).toBe("orange");
});

test("a new window frame offers a restart", async () => {
  saving();
  mocks.restart.mockResolvedValue(undefined);
  render(<SettingsPage />);

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
  render(<SettingsPage />);

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
  render(<SettingsPage />);

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
  render(<SettingsPage />);

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
  mocks.get.mockResolvedValue({ ...defaults, fellBack: ["theme", "frame"] });
  render(<SettingsPage />);

  expect(
    await screen.findByText(
      "Liurium could not read the saved theme and window frame and uses the default. Choose again to save it.",
    ),
  ).toBeDefined();
});

test("settings that cannot be loaded show why", async () => {
  mocks.get.mockRejectedValue(
    new CommandFailure("get_settings", { kind: "internal" }),
  );
  render(<SettingsPage />);

  expect(await screen.findByText("Settings could not be loaded")).toBeDefined();
});
