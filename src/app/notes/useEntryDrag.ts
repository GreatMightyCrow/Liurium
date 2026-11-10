import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { followPointer } from "../pointerDrag";
import { canMoveInto, parentOf } from "./tree";

// Dragging a note or folder onto a folder in the tree (M4-010), with pointer events
// as on the board: the browser's own drag never arrives on Windows (Tauri replaces
// WebView2's drag handler).

/** Near the top or bottom of the scrolling pane, it scrolls. */
const EDGE = 32;
const SCROLL_STEP = 10;

export interface EntryDrag {
  path: string;
  name: string;
  x: number;
  y: number;
  /** The folder it would move into; "" is the top of the project, null nowhere. */
  folder: string | null;
}

/** The folder under the pointer that `path` may move into, or null. */
function folderAt(
  root: HTMLElement,
  x: number,
  y: number,
  path: string,
): string | null {
  const element = document.elementFromPoint(x, y);
  if (element === null || !root.contains(element)) {
    return null;
  }
  const entry = element.closest<HTMLElement>("[data-path]");
  const at =
    entry === null || !root.contains(entry) ? undefined : entry.dataset.path;
  const folder =
    at === undefined ? "" : entry?.dataset.kind === "note" ? parentOf(at) : at;
  return canMoveInto(path, folder) ? folder : null;
}

/** The nearest ancestor that scrolls up and down. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") {
      return at;
    }
  }
  return null;
}

function scrollNear(root: HTMLElement, y: number): void {
  const pane = scroller(root);
  if (pane === null) {
    return;
  }
  const box = pane.getBoundingClientRect();
  if (y < box.top + EDGE) {
    pane.scrollBy({ top: -SCROLL_STEP });
  } else if (y > box.bottom - EDGE) {
    pane.scrollBy({ top: SCROLL_STEP });
  }
}

export function useEntryDrag(onDrop: (path: string, folder: string) => void): {
  drag: EntryDrag | null;
  startDrag: (
    event: ReactPointerEvent<HTMLElement>,
    root: HTMLElement | null,
    path: string,
    name: string,
  ) => void;
} {
  const [drag, setDrag] = useState<EntryDrag | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const dropped = useRef(onDrop);
  useEffect(() => {
    dropped.current = onDrop;
  });
  useEffect(
    () => () => {
      stop.current?.();
    },
    [],
  );

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    root: HTMLElement | null,
    path: string,
    name: string,
  ) => {
    if (
      root === null ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    stop.current?.();
    let folder: string | null = null;
    stop.current = followPointer(event, {
      move: (x, y) => {
        folder = folderAt(root, x, y, path);
        setDrag({ path, name, x, y, folder });
      },
      frame: (_x, y) => {
        scrollNear(root, y);
      },
      drop: () => {
        if (folder !== null) {
          dropped.current(path, folder);
        }
      },
      end: () => {
        stop.current = null;
        setDrag(null);
      },
    });
  };

  return { drag, startDrag };
}
