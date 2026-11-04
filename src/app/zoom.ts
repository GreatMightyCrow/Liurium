// Zoom (M3-009). WebView2's own zoom keys are off (`zoomHotkeysEnabled: false`), so
// Liurium catches Ctrl + Plus / Minus / 0 and Ctrl + mouse wheel itself and saves the
// new step; Rust then zooms the window. That way the stored zoom is always the one
// shown, also after a restart.

export type ZoomDirection = "in" | "out" | "reset";

/** The default step, 100 %. */
export const NORMAL_ZOOM = 100;

/** A fast wheel or touchpad sends many events for one gesture. */
const WHEEL_PAUSE_MS = 150;

type ModifierKeys = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey"
>;

/** `Ctrl + =` is Ctrl + Plus without Shift on many layouts. AltGr arrives as Ctrl +
 *  Alt and types characters, so it never zooms. */
export function zoomKey(event: ModifierKeys): ZoomDirection | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  switch (event.key) {
    case "+":
    case "=":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

/** The step after `current`; stays at the smallest and the largest. */
export function nextZoom(
  steps: readonly number[],
  current: number,
  direction: ZoomDirection,
): number {
  switch (direction) {
    case "reset":
      return NORMAL_ZOOM;
    case "in":
      return steps.find((step) => step > current) ?? current;
    case "out":
      return [...steps].reverse().find((step) => step < current) ?? current;
  }
}

/** Listens for the zoom keys and Ctrl + wheel; returns a function that stops. */
export function listenForZoom(
  target: Window,
  onZoom: (direction: ZoomDirection) => void,
): () => void {
  let lastWheel = Number.NEGATIVE_INFINITY;
  const onKeyDown = (event: KeyboardEvent) => {
    const direction = zoomKey(event);
    if (direction !== null) {
      event.preventDefault();
      onZoom(direction);
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheel < WHEEL_PAUSE_MS) {
      return;
    }
    lastWheel = now;
    onZoom(event.deltaY < 0 ? "in" : "out");
  };
  target.addEventListener("keydown", onKeyDown);
  // Not passive, so the browser does not zoom or scroll on its own.
  target.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("wheel", onWheel);
  };
}
