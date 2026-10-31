import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { AppInfo } from "./bindings/AppInfo";
import { toCommandFailure } from "./errors";

export type { AppInfo };
export type { DataStatus } from "./bindings/DataStatus";

// One function per Rust command (src-tauri/src/commands). Each command also needs
// its permission in src-tauri/capabilities/default.json (Security Model, ADR-0018).
// A failed command rejects with a CommandFailure.

export function getAppInfo(): Promise<AppInfo> {
  return call("app_info");
}

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toCommandFailure(command, reason);
  }
}
