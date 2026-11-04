// Liurium is a desktop app, not a web page (M2-013). WebView2's own context menu
// (Back, Refresh, Save as, Print) and its browser shortcuts are turned off here,
// because Tauri does not pass WebView2's switches for them through. Text fields
// keep their menu for cut, copy, and paste. Back and forward (Alt + arrows) and the
// developer tools of a debug build stay as they are. Zoom keys are Liurium's own
// (zoom.ts, M3-009).

/** Keys that reload, print, save, or search the page, or turn on caret browsing. */
const BROWSER_KEYS = new Set(["F3", "F5", "F7"]);
/** With Ctrl: reload, print, save, find, find next, open file, view source. */
const BROWSER_CTRL_KEYS = new Set(["r", "p", "s", "f", "g", "o", "u"]);

const TEXT_INPUTS = new Set([
  "text",
  "search",
  "url",
  "email",
  "password",
  "number",
  "tel",
]);

function editsText(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(target.type);
  }
  // Also a paragraph inside an editor. (jsdom has no `isContentEditable`.)
  return (
    target instanceof HTMLElement &&
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

function browserShortcut(event: KeyboardEvent): boolean {
  if (BROWSER_KEYS.has(event.key)) {
    return true;
  }
  // AltGr arrives as Ctrl + Alt; it types characters, never a shortcut.
  return (
    event.ctrlKey &&
    !event.altKey &&
    BROWSER_CTRL_KEYS.has(event.key.toLowerCase())
  );
}

/**
 * Only the browser's default is stopped: Liurium's own handlers still see the
 * event (e.g. Ctrl + S to save a note later). Returns a function that undoes it.
 */
export function blockBrowserBehavior(target: Window): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (!editsText(event.target)) {
      event.preventDefault();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (browserShortcut(event)) {
      event.preventDefault();
    }
  };
  target.addEventListener("contextmenu", onContextMenu);
  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("contextmenu", onContextMenu);
    target.removeEventListener("keydown", onKeyDown);
  };
}
