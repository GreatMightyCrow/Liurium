import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { AddOutcome } from "./bindings/AddOutcome";
import type { AppDataInfo } from "./bindings/AppDataInfo";
import type { AppInfo } from "./bindings/AppInfo";
import type { CurrentProject } from "./bindings/CurrentProject";
import type { ProjectEntry } from "./bindings/ProjectEntry";
import type { ProjectInfo } from "./bindings/ProjectInfo";
import type { ProjectStatus } from "./bindings/ProjectStatus";
import type { Settings } from "./bindings/Settings";
import type { SettingsView } from "./bindings/SettingsView";
import { toCommandFailure } from "./errors";

export type {
  AddOutcome,
  AppDataInfo,
  AppInfo,
  CurrentProject,
  ProjectEntry,
  ProjectInfo,
  ProjectStatus,
  Settings,
  SettingsView,
};
export type { DataStatus } from "./bindings/DataStatus";
export type { FrameStyle } from "./bindings/FrameStyle";
export type { Mode } from "./bindings/Mode";
export type { SettingKey } from "./bindings/SettingKey";
export type { StartWith } from "./bindings/StartWith";
export type { SyncTool } from "./bindings/SyncTool";
export type { ThemeChoice } from "./bindings/ThemeChoice";
export type { Zoom } from "./bindings/Zoom";

// One function per Rust command (src-tauri/src/commands). Each command also needs
// its permission in src-tauri/capabilities/default.json (Security Model, ADR-0018).
// A failed command rejects with a CommandFailure.

export function getAppInfo(): Promise<AppInfo> {
  return call("app_info");
}

/** The open project; on the first call, Rust reopens the one from the last run. */
export function getCurrentProject(): Promise<CurrentProject> {
  return call("current_project");
}

/** Rust shows the folder dialog; `null` when the user cancels it. A copy of a listed
 *  project is not added: Rust keeps it for `separateProjectCopy` (M2-011). */
export function addProject(): Promise<AddOutcome | null> {
  return call("add_project");
}

/** Gives the copy found by the last `addProject` its own identity and opens it. */
export function separateProjectCopy(): Promise<ProjectInfo> {
  return call("separate_project_copy");
}

/** All known projects, the most recently opened first. */
export function listProjects(): Promise<ProjectEntry[]> {
  return call("list_projects");
}

/** Makes the project the open one; the one open before closes. */
export function openProject(id: string): Promise<ProjectInfo> {
  return call("open_project", { id });
}

/** Renames the project in its folder, so the name travels with it. */
export function renameProject(id: string, name: string): Promise<void> {
  return call("rename_project", { id, name });
}

/** Removes the project from the list; its folder stays as it is. */
export function removeProject(id: string): Promise<void> {
  return call("remove_project", { id });
}

/** Rust shows the folder dialog to find a moved project; `null` when cancelled. */
export function locateProject(id: string): Promise<ProjectInfo | null> {
  return call("locate_project", { id });
}

export function getSettings(): Promise<SettingsView> {
  return call("get_settings");
}

/** Saves, then Rust changes the window's icon, background, mode, and zoom at once. */
export function updateSettings(settings: Settings): Promise<SettingsView> {
  return call("update_settings", { settings });
}

/** Closes Liurium and starts it again, so a new window frame applies. */
export function restartApp(): Promise<void> {
  return call("restart_app");
}

/** Where Liurium keeps its own data, its backup copies, and the sync warnings. */
export function getAppDataInfo(): Promise<AppDataInfo> {
  return call("app_data_info");
}

/** Rust opens the app data folder in Explorer; the page cannot name another path. */
export function openAppDataFolder(): Promise<void> {
  return call("open_app_data_folder");
}

/** Deletes all but the newest backup copies; ask the user first. */
export function pruneBackups(): Promise<AppDataInfo> {
  return call("prune_backups");
}

/** Every project shows its sync-folder warning once more. */
export function resetSyncWarnings(): Promise<AppDataInfo> {
  return call("reset_sync_warnings");
}

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toCommandFailure(command, reason);
  }
}
