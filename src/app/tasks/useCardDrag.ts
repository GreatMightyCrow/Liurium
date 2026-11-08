import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { indexAt, type Target } from "./board";

// Dragging a card with pointer events (M4-004). The browser's own drag does not work
// here: Tauri replaces WebView2's drag handler on Windows.

/** A press that moves less than this is a click. */
const START_DISTANCE = 5;
/** Near the edges of the board or a column, the view scrolls. */
const EDGE = 48;
const SCROLL_STEP = 12;

export interface Drag {
  task: string;
  title: string;
  x: number;
  y: number;
  over: Target | null;
}

function targetAt(x: number, y: number, task: string): Target | null {
  const column = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-column]");
  const id = column?.dataset.column;
  if (column === undefined || column === null || id === undefined) {
    return null;
  }
  const middles = [...column.querySelectorAll<HTMLElement>("[data-task]")]
    .filter((card) => card.dataset.task !== task)
    .map((card) => {
      const box = card.getBoundingClientRect();
      return box.top + box.height / 2;
    });
  return { column: id, index: indexAt(middles, y) };
}

function scrollNear(x: number, y: number): void {
  const board = document.querySelector<HTMLElement>("[data-board]");
  if (board !== null) {
    const box = board.getBoundingClientRect();
    if (x < box.left + EDGE) {
      board.scrollBy({ left: -SCROLL_STEP });
    } else if (x > box.right - EDGE) {
      board.scrollBy({ left: SCROLL_STEP });
    }
  }
  const list = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-column-list]");
  if (list !== undefined && list !== null) {
    const box = list.getBoundingClientRect();
    if (y < box.top + EDGE) {
      list.scrollBy({ top: -SCROLL_STEP });
    } else if (y > box.bottom - EDGE) {
      list.scrollBy({ top: SCROLL_STEP });
    }
  }
}

/** After a drag, the click that ends it must not open the card. */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => {
    window.removeEventListener("click", swallow, { capture: true });
  }, 0);
}

export function useCardDrag(
  onDrop: (task: string, target: Target) => void,
  enabled: boolean,
): {
  drag: Drag | null;
  startDrag: (
    event: ReactPointerEvent<HTMLElement>,
    task: string,
    title: string,
  ) => void;
} {
  const [drag, setDrag] = useState<Drag | null>(null);
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
    task: string,
    title: string,
  ) => {
    if (!enabled || event.button !== 0 || event.ctrlKey || event.shiftKey) {
      return;
    }
    stop.current?.();
    const from = { x: event.clientX, y: event.clientY };
    let last = from;
    let started = false;
    let over: Target | null = null;
    let frame = 0;

    const scroll = () => {
      scrollNear(last.x, last.y);
      frame = window.requestAnimationFrame(scroll);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", key, { capture: true });
      window.cancelAnimationFrame(frame);
      stop.current = null;
      setDrag(null);
    };
    const move = (next: PointerEvent) => {
      last = { x: next.clientX, y: next.clientY };
      if (
        !started &&
        Math.hypot(last.x - from.x, last.y - from.y) < START_DISTANCE
      ) {
        return;
      }
      if (!started) {
        started = true;
        frame = window.requestAnimationFrame(scroll);
      }
      over = targetAt(last.x, last.y, task);
      setDrag({ task, title, x: last.x, y: last.y, over });
    };
    const up = () => {
      finish();
      if (started) {
        swallowNextClick();
        if (over !== null) {
          dropped.current(task, over);
        }
      }
    };
    const key = (next: KeyboardEvent) => {
      if (next.key === "Escape") {
        next.preventDefault();
        next.stopPropagation();
        finish();
        if (started) {
          swallowNextClick();
        }
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", key, { capture: true });
    stop.current = finish;
  };

  return { drag, startDrag };
}
