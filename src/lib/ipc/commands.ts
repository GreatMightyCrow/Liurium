import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { AppInfo } from "./bindings/AppInfo";
import type { CurrentProject } from "./bindings/CurrentProject";
import type { ProjectInfo } from "./bindings/ProjectInfo";
import { toCommandFailure } from "./errors";

export type { AppInfo, CurrentProject, ProjectInfo };
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

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toCommandFailure(command, reason);
  }
}
