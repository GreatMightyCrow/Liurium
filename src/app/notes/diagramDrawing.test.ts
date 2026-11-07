import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiagramLook } from "../../diagramFrame/protocol";

const LOOK: DiagramLook = { dark: true, colors: { background: "#000" } };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>';

/** A fresh module each test: one frame, one cache, per page. */
const load = () => import("./diagramDrawing");

const frames = () => [...document.querySelectorAll("iframe")];
const frame = () => {
  const found = frames().pop();
  if (found === undefined) {
    throw new Error("no frame");
  }
  return found;
};

function fromFrame(
  data: unknown,
  source: Window | null = frame().contentWindow,
) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

/** What the page sent the current frame, as a spy on its window. */
function watchRequests() {
  const window = frame().contentWindow;
  if (window === null) {
    throw new Error("no window");
  }
  return vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
}

const drawn = (id: number, svg: unknown = SVG, more: object = {}) => ({
  kind: "drawn",
  id,
  svg,
  width: 120,
  height: 80,
  description: "Diagram: Plan",
  ...more,
});

const settle = () => vi.advanceTimersByTimeAsync(0);

let makeAddress: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  document.body.replaceChildren();
  let count = 0;
  makeAddress = vi.fn(() => {
    count += 1;
    return `blob:picture-${String(count)}`;
  });
  revoke = vi.fn();
  URL.createObjectURL = makeAddress as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Asks for a diagram and answers it as the frame would. */
async function answered(
  drawDiagram: (source: string, look: DiagramLook) => Promise<unknown>,
  source: string,
  answer: (id: number) => unknown,
) {
  const result = drawDiagram(source, LOOK);
  await settle();
  const requests = watchRequests();
  fromFrame({ kind: "ready" });
  await settle();
  const sent = requests.mock.lastCall?.[0] as { id: number };
  fromFrame(answer(sent.id));
  return result;
}

describe("the frame", () => {
  test("comes with the first diagram, sandboxed without an origin of its own", async () => {
    const { drawDiagram } = await load();
    expect(frames()).toHaveLength(0);

    void drawDiagram("flowchart TD", LOOK);
    await settle();

    expect(frames()).toHaveLength(1);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().src).toBe(
      "http://liurium-diagram.localhost/diagram-frame.html",
    );
    // Out of the way of the keyboard and a screen reader.
    expect(frame().inert).toBe(true);
    expect(frame().getAttribute("aria-hidden")).toBe("true");
    expect(frame().tabIndex).toBe(-1);
    // Off screen, as Mermaid has to measure.
    expect(frame().style.display).not.toBe("none");
    expect(frame().style.left).toBe("-10000px");
  });

  test("gets the text and the look only once it is ready", async () => {
    const { drawDiagram } = await load();
    void drawDiagram("flowchart TD", LOOK);
    await settle();
    const requests = watchRequests();
    expect(requests).not.toHaveBeenCalled();

    fromFrame({ kind: "ready" });
    await settle();

    expect(requests).toHaveBeenCalledWith(
      { id: 1, source: "flowchart TD", look: LOOK },
      "*",
    );
  });

  test("a message from anywhere else is not listened to", async () => {
    const { drawDiagram } = await load();
    void drawDiagram("flowchart TD", LOOK);
    await settle();
    const requests = watchRequests();

    fromFrame({ kind: "ready" }, window);
    fromFrame({ kind: "ready" }, null);
    await settle();

    expect(requests).not.toHaveBeenCalled();
  });
});

describe("an answer", () => {
  test("a drawing becomes a picture's address and nothing else", async () => {
    const { drawDiagram } = await load();
    const result = await answered(drawDiagram, "flowchart TD", (id) =>
      drawn(id),
    );

    expect(result).toEqual({
      kind: "drawn",
      address: "blob:picture-1",
      width: 120,
      height: 80,
      description: "Diagram: Plan",
    });
    const blob = makeAddress.mock.lastCall?.[0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    expect(document.querySelector("svg")).toBeNull();
  });

  test.each<[string, (id: number) => unknown]>([
    ["no string", (id) => drawn(id, 7)],
    ["markup that is no picture", (id) => drawn(id, "<script>x</script>")],
    ["text before the picture", (id) => drawn(id, `<div></div>${SVG}`)],
    ["too much text", (id) => drawn(id, `<svg${"x".repeat(5_000_000)}`)],
    ["a width that is no number", (id) => drawn(id, SVG, { width: "120" })],
    ["no width", (id) => drawn(id, SVG, { width: Number.NaN })],
    ["a width below zero", (id) => drawn(id, SVG, { width: -1 })],
    ["a huge height", (id) => drawn(id, SVG, { height: 100_001 })],
    ["an unknown kind", (id) => ({ kind: "other", id })],
  ])("%s is refused", async (_name, answer) => {
    const { drawDiagram } = await load();
    const result = await answered(drawDiagram, "flowchart TD", answer);

    expect(result).toEqual({
      kind: "failed",
      reason: "The drawing could not be used",
    });
    expect(makeAddress).not.toHaveBeenCalled();
  });

  test("a description and a reason are cut to size", async () => {
    const { drawDiagram } = await load();
    const long = "x".repeat(1000);
    const first = await answered(drawDiagram, "a", (id) =>
      drawn(id, SVG, { description: long }),
    );
    expect(first).toMatchObject({ description: "x".repeat(500) });

    const second = drawDiagram("b", LOOK);
    await settle();
    const requests = watchRequests();
    await settle();
    const sent = requests.mock.lastCall?.[0] as { id: number };
    fromFrame({ kind: "failed", id: sent.id, reason: long });
    expect(await second).toEqual({ kind: "failed", reason: "x".repeat(300) });
  });

  test("an answer to another diagram changes nothing", async () => {
    const { drawDiagram } = await load();
    const finished = vi.fn();
    void drawDiagram("flowchart TD", LOOK).then(finished);
    await settle();
    watchRequests();
    fromFrame({ kind: "ready" });
    await settle();

    fromFrame(drawn(99));
    fromFrame("not even an object");
    await settle();

    expect(finished).not.toHaveBeenCalled();
    expect(makeAddress).not.toHaveBeenCalled();
  });
});

describe("waiting", () => {
  test("a frame that does not answer is thrown away, the next diagram gets a new one", async () => {
    const { drawDiagram, drawnBefore } = await load();
    const slow = drawDiagram("slow", LOOK);
    await settle();
    const first = frame();
    watchRequests();
    fromFrame({ kind: "ready" });
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await slow).toEqual({
      kind: "failed",
      reason: "It took too long to draw",
    });
    expect(first.isConnected).toBe(false);
    // It is not tried again by itself, or each redraw would stop the frame anew.
    expect(drawnBefore("slow", LOOK)).toEqual(await slow);

    void drawDiagram("next", LOOK);
    await settle();
    expect(frame()).not.toBe(first);
    expect(frames()).toHaveLength(1);
  });

  test("a frame that never starts is thrown away, and may work next time", async () => {
    const { drawDiagram, drawnBefore } = await load();
    const late = drawDiagram("flowchart TD", LOOK);
    await settle();
    const first = frame();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await late).toEqual({
      kind: "failed",
      reason: "Diagrams could not be started",
    });
    expect(first.isConnected).toBe(false);
    expect(drawnBefore("flowchart TD", LOOK)).toBeUndefined();
  });

  test("one at a time, and the same diagram is asked for once", async () => {
    const { drawDiagram } = await load();
    const one = drawDiagram("one", LOOK);
    const same = drawDiagram("one", LOOK);
    const two = drawDiagram("two", LOOK);
    await settle();
    const requests = watchRequests();
    fromFrame({ kind: "ready" });
    await settle();
    expect(requests).toHaveBeenCalledTimes(1);

    fromFrame(drawn(1));
    await settle();
    expect(requests).toHaveBeenCalledTimes(2);
    fromFrame(drawn(2));

    expect(await one).toEqual(await same);
    expect(await two).toMatchObject({ address: "blob:picture-2" });
  });

  test("a text longer than Mermaid's limit is not sent", async () => {
    const { drawDiagram, MAX_SOURCE_LENGTH } = await load();
    const result = await drawDiagram("x".repeat(MAX_SOURCE_LENGTH + 1), LOOK);

    expect(result).toEqual({ kind: "failed", reason: "It is too long" });
    expect(frames()).toHaveLength(0);
  });
});

describe("keeping", () => {
  test("a diagram drawn before shows at once, for the same look only", async () => {
    const { drawDiagram, drawnBefore } = await load();
    const result = await answered(drawDiagram, "flowchart TD", (id) =>
      drawn(id),
    );

    expect(drawnBefore("flowchart TD", LOOK)).toEqual(result);
    expect(
      drawnBefore("flowchart TD", { ...LOOK, dark: false }),
    ).toBeUndefined();
    expect(await drawDiagram("flowchart TD", LOOK)).toEqual(result);
    expect(makeAddress).toHaveBeenCalledTimes(1);
  });

  test("beyond the limit the oldest goes, with its address", async () => {
    const { drawDiagram, drawnBefore } = await load();
    await answered(drawDiagram, "diagram 0", (id) => drawn(id));
    for (let number = 1; number <= 100; number += 1) {
      const next = drawDiagram(`diagram ${String(number)}`, LOOK);
      await settle();
      fromFrame(drawn(number + 1));
      await next;
    }

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:picture-1");
    expect(drawnBefore("diagram 0", LOOK)).toBeUndefined();
    expect(drawnBefore("diagram 1", LOOK)).toBeDefined();
  });
});
