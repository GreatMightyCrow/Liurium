import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { AppInfo } from "./bindings/AppInfo";
import type { CurrentProject } from "./bindings/CurrentProject";
import type { ProjectEntry } from "./bindings/ProjectEntry";
import type { ProjectInfo } from "./bindings/ProjectInfo";
import type { ProjectStatus } from "./bindings/ProjectStatus";
import { toCommandFailure } from "./errors";

export type {
  AppInfo,
  CurrentProject,
  ProjectEntry,
  ProjectInfo,
  ProjectStatus,
};
export type { DataStatus } from "./bindings/DataStatus";

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

/** Rust shows the folder dialog; `null` when the user cancels it. */
export function addProject(): Promise<ProjectInfo | null> {
  return call("add_project");
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

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toCommandFailure(command, reason);
  }
}
