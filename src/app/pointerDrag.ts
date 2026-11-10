// Dragging with pointer events, shared by the task board (M4-004) and the notes tree
// (M4-010). The browser's own drag does not work here: Tauri replaces WebView2's drag
// handler on Windows.

/** A press that moves less than this is a click. */
export const START_DISTANCE = 5;

export interface PointerDragHandlers {
  /** The press moved far enough to be a drag, and then at every move. */
  move: (x: number, y: number) => void;
  /** Every frame while dragging, at the last place, to scroll near edges. */
  frame?: (x: number, y: number) => void;
  /** Let go after a drag. Not called for a click, Escape, or a cancel. */
  drop: () => void;
  /** The press is over: dropped, a click, Escape, a cancel, or stopped. */
  end: () => void;
}

/** After a drag, the click that ends it must not open or toggle what was dragged. */
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

/** Follows the pointer from a press; returns a function that stops following. */
export function followPointer(
  press: { clientX: number; clientY: number },
  on: PointerDragHandlers,
): () => void {
  const from = { x: press.clientX, y: press.clientY };
  let last = from;
  let started = false;
  let frame = 0;

  const tick = () => {
    on.frame?.(last.x, last.y);
    frame = window.requestAnimationFrame(tick);
  };
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("keydown", key, { capture: true });
    window.cancelAnimationFrame(frame);
    on.end();
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
      frame = window.requestAnimationFrame(tick);
    }
    on.move(last.x, last.y);
  };
  const up = () => {
    finish();
    if (started) {
      swallowNextClick();
      on.drop();
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
  return finish;
}
