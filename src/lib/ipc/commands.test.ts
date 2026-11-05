import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, test, vi } from "vitest";
import {
  backlinksOf,
  closeNote,
  createFolder,
  createNote,
  getAppDataInfo,
  getAppInfo,
  listNotes,
  moveEntry,
  noteLinks,
  openAppDataFolder,
  openNote,
  projectTags,
  pruneBackups,
  renameEntry,
  resetSyncWarnings,
  resolveNoteConflict,
  trashEntry,
  updateNote,
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

test("the note commands send the path and their arguments under Rust's names", async () => {
  invokeMock.mockResolvedValue(undefined);

  await openNote("Ideas/Plan.md");
  await openNote("Ideas/Plan.md", true);
  await updateNote("Ideas/Plan.md", "text", false);
  await resolveNoteConflict("Ideas/Plan.md", "keepBoth");
  await closeNote("Ideas/Plan.md");

  expect(invokeMock.mock.calls).toEqual([
    ["open_note", { path: "Ideas/Plan.md", unify: false }],
    ["open_note", { path: "Ideas/Plan.md", unify: true }],
    ["update_note", { path: "Ideas/Plan.md", text: "text", save: false }],
    ["resolve_note_conflict", { path: "Ideas/Plan.md", choice: "keepBoth" }],
    ["close_note", { path: "Ideas/Plan.md" }],
  ]);
});

test("the organize commands send paths and names under Rust's names", async () => {
  invokeMock.mockResolvedValue("x");

  await createNote("Ideas", "Idea");
  await createFolder("", "Ideas");
  await renameEntry("Ideas/Idea.md", "Plan");
  await moveEntry("Ideas/Plan.md", "");
  await trashEntry("Plan.md");

  expect(invokeMock.mock.calls).toEqual([
    ["create_note", { folder: "Ideas", name: "Idea" }],
    ["create_folder", { parent: "", name: "Ideas" }],
    ["rename_entry", { path: "Ideas/Idea.md", name: "Plan" }],
    ["move_entry", { path: "Ideas/Plan.md", folder: "" }],
    ["trash_entry", { path: "Plan.md" }],
  ]);
});

test("note_links sends the path and the editor's text", async () => {
  invokeMock.mockResolvedValue([]);

  await noteLinks("Home.md", "See [[Plan]]");

  expect(invokeMock).toHaveBeenCalledWith("note_links", {
    path: "Home.md",
    text: "See [[Plan]]",
  });
});

test("projectTags asks for the open project's tags", async () => {
  invokeMock.mockResolvedValue([]);

  await projectTags();

  expect(invokeMock).toHaveBeenCalledWith("project_tags", undefined);
});

test("backlinks sends the note's path", async () => {
  invokeMock.mockResolvedValue([]);

  await backlinksOf("Plan.md");

  expect(invokeMock).toHaveBeenCalledWith("backlinks", { path: "Plan.md" });
});
