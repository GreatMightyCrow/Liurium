import {
  type DiagramLook,
  type DrawRequest,
  FRAME_ADDRESS,
} from "../../diagramFrame/protocol";

// The page's side of the diagram frame (M3-011, ADR-0021). One hidden frame draws one
// diagram at a time. What it answers is untrusted: only a string that starts with `<svg`
// goes any further, and only into an image, where it can run and load nothing. This file
// never puts an answer into the page as markup.

export type DiagramResult =
  | {
      kind: "drawn";
      address: string;
      width: number;
      height: number;
      description: string;
    }
  | { kind: "failed"; reason: string };

/** As Mermaid's own limit; a longer text is not even sent. */
export const MAX_SOURCE_LENGTH = 50_000;
const MAX_SVG_LENGTH = 5_000_000;
const MAX_SIDE = 100_000;
const MAX_REASON_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_KEPT = 100;
/** The first start loads Mermaid. */
const START_TIMEOUT_MS = 20_000;
const DRAW_TIMEOUT_MS = 10_000;

interface Running {
  element: HTMLIFrameElement;
  ready: Promise<boolean>;
  heard: (message: unknown) => void;
}

let running: Running | null = null;
let listening = false;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();
const kept = new Map<string, DiagramResult>();
const pending = new Map<string, Promise<DiagramResult>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function listen(): void {
  if (!listening) {
    listening = true;
    window.addEventListener("message", (event) => {
      if (running !== null && event.source === running.element.contentWindow) {
        running.heard(event.data);
      }
    });
  }
}

function startFrame(): Running {
  listen();
  const element = document.createElement("iframe");
  // No `allow-same-origin`: the frame has no origin, so nothing of the page's is its own.
  element.setAttribute("sandbox", "allow-scripts");
  element.setAttribute("aria-hidden", "true");
  element.title = "Diagram drawing";
  element.tabIndex = -1;
  element.inert = true;
  // Off screen, not `display: none`: Mermaid measures text.
  element.style.position = "fixed";
  element.style.left = "-10000px";
  element.style.top = "0";
  element.style.width = "1200px";
  element.style.height = "800px";
  let heard: (message: unknown) => void = () => undefined;
  const ready = new Promise<boolean>((done) => {
    const timer = setTimeout(() => {
      done(false);
    }, START_TIMEOUT_MS);
    heard = (message) => {
      if (isRecord(message) && message.kind === "ready") {
        clearTimeout(timer);
        done(true);
      }
    };
  });
  const started: Running = { element, ready, heard };
  element.src = FRAME_ADDRESS;
  document.body.append(element);
  return started;
}

/** A frame that takes too long is thrown away. A diagram that truly never ends keeps its
 *  process busy, so the next frame may not start until the app restarts; the editor is
 *  not held up either way. */
function throwAwayFrame(): void {
  running?.element.remove();
  running = null;
}

/** What an answer may be, or `null` for anything else. */
function usable(message: unknown, id: number): DiagramResult | "other" | null {
  if (!isRecord(message) || message.id !== id) {
    return "other";
  }
  if (message.kind === "failed") {
    return {
      kind: "failed",
      reason:
        typeof message.reason === "string"
          ? message.reason.slice(0, MAX_REASON_LENGTH)
          : "Mermaid could not read it",
    };
  }
  const { kind, svg, width, height, description } = message;
  if (
    kind !== "drawn" ||
    typeof svg !== "string" ||
    svg.length > MAX_SVG_LENGTH ||
    !svg.startsWith("<svg") ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width >= 0 && width <= MAX_SIDE) ||
    !(height >= 0 && height <= MAX_SIDE)
  ) {
    return null;
  }
  return {
    kind: "drawn",
    address: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
    width,
    height,
    description:
      typeof description === "string"
        ? description.slice(0, MAX_DESCRIPTION_LENGTH)
        : "Diagram",
  };
}

const NOT_USABLE: DiagramResult = {
  kind: "failed",
  reason: "The drawing could not be used",
};
const TOO_LONG: DiagramResult = {
  kind: "failed",
  reason: "It took too long to draw",
};
const NOT_STARTED: DiagramResult = {
  kind: "failed",
  reason: "Diagrams could not be started",
};

async function ask(
  source: string,
  look: DiagramLook,
): Promise<{ result: DiagramResult; keep: boolean }> {
  running ??= startFrame();
  const frame = running;
  if (!(await frame.ready)) {
    throwAwayFrame();
    // It may work when the next diagram asks.
    return { result: NOT_STARTED, keep: false };
  }
  const id = nextId;
  nextId += 1;
  const result = await new Promise<DiagramResult>((done) => {
    const timer = setTimeout(() => {
      throwAwayFrame();
      done(TOO_LONG);
    }, DRAW_TIMEOUT_MS);
    frame.heard = (message) => {
      const answer = usable(message, id);
      if (answer !== "other") {
        clearTimeout(timer);
        done(answer ?? NOT_USABLE);
      }
    };
    const request: DrawRequest = { id, source, look };
    // Any origin, as a sandboxed frame has none. It is this page's own frame, and the
    // page's `frame-src` keeps it from going anywhere else.
    frame.element.contentWindow?.postMessage(request, "*");
  });
  return { result, keep: true };
}

const keyOf = (source: string, look: DiagramLook) =>
  JSON.stringify([source, look]);

function keep(key: string, result: DiagramResult): void {
  kept.set(key, result);
  const oldest = kept.keys().next().value;
  if (kept.size > MAX_KEPT && oldest !== undefined) {
    const dropped = kept.get(oldest);
    kept.delete(oldest);
    if (dropped?.kind === "drawn") {
      URL.revokeObjectURL(dropped.address);
    }
  }
}

/** A diagram drawn before, so it shows at once and the text does not move. */
export const drawnBefore = (
  source: string,
  look: DiagramLook,
): DiagramResult | undefined => kept.get(keyOf(source, look));

export function drawDiagram(
  source: string,
  look: DiagramLook,
): Promise<DiagramResult> {
  const key = keyOf(source, look);
  const known = kept.get(key);
  if (known !== undefined) {
    return Promise.resolve(known);
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    return Promise.resolve({ kind: "failed", reason: "It is too long" });
  }
  const waiting = pending.get(key);
  if (waiting !== undefined) {
    return waiting;
  }
  const work = queue.then(async () => {
    const { result, keep: worthKeeping } = await ask(source, look);
    pending.delete(key);
    if (worthKeeping) {
      keep(key, result);
    }
    return result;
  });
  pending.set(key, work);
  queue = work;
  return work;
}
