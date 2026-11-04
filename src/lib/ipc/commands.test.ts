import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, test, vi } from "vitest";
import {
  getAppDataInfo,
  getAppInfo,
  listNotes,
  openAppDataFolder,
  pruneBackups,
  resetSyncWarnings,
  updateSettings,
} from "./commands";
import { CommandFailure } from "./errors";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

test("getAppInfo calls app_info and returns its result", async () => {
  const info = { version: "0.1.0", data: { state: "ready" } };
  invokeMock.mockResolvedValue(info);

  await expect(getAppInfo()).resolves.toEqual(info);
  expect(invokeMock).toHaveBeenCalledWith("app_info", undefined);
});

test("updateSettings sends the settings under the name Rust expects", async () => {
  const settings = {
    theme: "mint",
    mode: "light",
    frame: "hidden",
    startup: "projectList",
    zoom: 125,
  } as const;
  invokeMock.mockResolvedValue({
    settings,
    frameAtStart: "liurium",
    fellBack: [],
    zoomSteps: [100, 125],
  });

  await updateSettings(settings);

  expect(invokeMock).toHaveBeenCalledWith("update_settings", { settings });
});

test.each([
  [getAppDataInfo, "app_data_info"],
  [openAppDataFolder, "open_app_data_folder"],
  [pruneBackups, "prune_backups"],
  [resetSyncWarnings, "reset_sync_warnings"],
  [listNotes, "list_notes"],
] as const)(
  "the app data and notes commands send no arguments",
  async (command, name) => {
    invokeMock.mockResolvedValue(undefined);

    await command();

    expect(invokeMock).toHaveBeenCalledWith(name, undefined);
  },
);

test("an error from Rust becomes a typed CommandFailure", async () => {
  invokeMock.mockRejectedValue({ kind: "tooLarge", maxBytes: 10 });

  const failure: unknown = await getAppInfo().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CommandFailure);
  expect((failure as CommandFailure).command).toBe("app_info");
  expect((failure as CommandFailure).error).toEqual({
    kind: "tooLarge",
    maxBytes: 10,
  });
});

test("a rejection from Tauri itself becomes an internal failure", async () => {
  const denied =
    "app_info not allowed. Permissions associated with this command: allow-app-info";
  invokeMock.mockRejectedValue(denied);

  const failure: unknown = await getAppInfo().catch((error: unknown) => error);

  expect((failure as CommandFailure).error).toEqual({ kind: "internal" });
  expect((failure as CommandFailure).reason).toBe(denied);
});
