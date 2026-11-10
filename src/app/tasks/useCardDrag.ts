import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { followPointer } from "../pointerDrag";
import { indexAt, type Target } from "./board";

// Dragging a card with pointer events (M4-004); the following itself is shared with
// the notes tree in `pointerDrag.ts`.

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
    let over: Target | null = null;
    stop.current = followPointer(event, {
      move: (x, y) => {
        over = targetAt(x, y, task);
        setDrag({ task, title, x, y, over });
      },
      frame: scrollNear,
      drop: () => {
        if (over !== null) {
          dropped.current(task, over);
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
