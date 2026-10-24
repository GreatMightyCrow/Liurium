import { getCurrentWindow } from "@tauri-apps/api/window";

// Window buttons of the custom frame styles. Each call needs its permission in
// src-tauri/capabilities/default.json (Security Model, M1-009).

export function minimizeWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}
