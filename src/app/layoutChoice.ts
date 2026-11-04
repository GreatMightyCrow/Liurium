import { useState } from "react";

// Layout choices remembered in this window's storage (M3-014): how wide the app
// sidebar is and whether the note list shows. They are looks for one viewer, not
// project data. Storage can be missing or refuse writes; the default applies then.

function read(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(key);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Not remembered; the choice still holds while the window is open.
  }
}

/** A boolean choice with a default, remembered under `key`. */
export function useLayoutChoice(
  key: string,
  fallback: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => read(key) ?? fallback);
  return [
    value,
    (next) => {
      write(key, next);
      setValue(next);
    },
  ];
}

const NOTES_KEY = "liurium.sidebar.collapsed.notes";
const OTHER_KEY = "liurium.sidebar.collapsed.other";

/** Whether `location` is on the Notes page, where the sidebar starts collapsed. */
export function onNotes(location: string): boolean {
  return location === "/notes" || location.startsWith("/notes/");
}

/** The app sidebar: collapsed on Notes and open elsewhere unless the user chose
 *  otherwise there (owner, 2026-11-04). */
export function useSidebarCollapsed(
  location: string,
): [boolean, (collapsed: boolean) => void] {
  const [onNotesPage, setOnNotesPage] = useLayoutChoice(NOTES_KEY, true);
  const [elsewhere, setElsewhere] = useLayoutChoice(OTHER_KEY, false);
  return onNotes(location)
    ? [onNotesPage, setOnNotesPage]
    : [elsewhere, setElsewhere];
}
