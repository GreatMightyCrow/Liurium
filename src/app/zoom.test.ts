import { afterEach, expect, test, vi } from "vitest";
import { listenForZoom, nextZoom, zoomKey } from "./zoom";

const steps = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

function key(key: string, extra: Partial<KeyboardEventInit> = {}) {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    cancelable: true,
    ...extra,
  });
}

test.each([
  ["+", "in"],
  ["=", "in"],
  ["-", "out"],
  ["0", "reset"],
])("Ctrl + %s zooms %s", (pressed, direction) => {
  expect(zoomKey(key(pressed))).toBe(direction);
});

test.each([
  ["without Ctrl", key("+", { ctrlKey: false })],
  ["with AltGr (Ctrl + Alt)", key("+", { altKey: true })],
  ["with Windows key", key("+", { metaKey: true })],
  ["another key", key("s")],
])("no zoom %s", (_name, event) => {
  expect(zoomKey(event)).toBeNull();
});

test("the next step goes one step up or down and stops at the ends", () => {
  expect(nextZoom(steps, 100, "in")).toBe(110);
  expect(nextZoom(steps, 100, "out")).toBe(90);
  expect(nextZoom(steps, 200, "in")).toBe(200);
  expect(nextZoom(steps, 50, "out")).toBe(50);
  expect(nextZoom(steps, 150, "reset")).toBe(100);
});

test("a zoom that is not a step moves to the nearest step in that direction", () => {
  expect(nextZoom(steps, 130, "in")).toBe(150);
  expect(nextZoom(steps, 130, "out")).toBe(125);
});

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

test("keys and Ctrl + wheel zoom the page instead of the browser", () => {
  const onZoom = vi.fn();
  stop = listenForZoom(window, onZoom);

  const plus = key("+");
  window.dispatchEvent(plus);
  const wheelUp = new WheelEvent("wheel", {
    deltaY: -100,
    ctrlKey: true,
    cancelable: true,
  });
  window.dispatchEvent(wheelUp);

  expect(onZoom.mock.calls).toEqual([["in"], ["in"]]);
  expect(plus.defaultPrevented).toBe(true);
  expect(wheelUp.defaultPrevented).toBe(true);
});

test("a fast wheel gives one step, not one per event", () => {
  vi.useFakeTimers();
  try {
    const onZoom = vi.fn();
    stop = listenForZoom(window, onZoom);
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 40,
          ctrlKey: true,
          cancelable: true,
        }),
      );
    }
    vi.advanceTimersByTime(200);
    window.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 40, ctrlKey: true, cancelable: true }),
    );

    expect(onZoom.mock.calls).toEqual([["out"], ["out"]]);
  } finally {
    vi.useRealTimers();
  }
});

test("a wheel without Ctrl scrolls as usual", () => {
  const onZoom = vi.fn();
  stop = listenForZoom(window, onZoom);
  const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });

  window.dispatchEvent(wheel);

  expect(onZoom).not.toHaveBeenCalled();
  expect(wheel.defaultPrevented).toBe(false);
});

test("stopping removes both listeners", () => {
  const onZoom = vi.fn();
  listenForZoom(window, onZoom)();

  window.dispatchEvent(key("+"));
  window.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, cancelable: true }),
  );

  expect(onZoom).not.toHaveBeenCalled();
});
