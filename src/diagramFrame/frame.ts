import mermaid from "mermaid";
import type { DrawRequest, FrameMessage } from "./protocol";

// Runs inside `<iframe sandbox="allow-scripts">`, with its own CSP (M3-011). A diagram's
// text is untrusted and Mermaid is very large, so it runs here: no origin of its own,
// nothing it may connect to, no inline script. On Windows Tauri's scripts also run in a
// frame, but its calls do not reach the app (tested in `e2e/diagrams.spec.ts`). It only
// gets text and answers with text, which the page shows as an image.

const FONT = '"Segoe UI", sans-serif';
const MAX_DESCRIPTION = 500;

function say(message: FrameMessage): void {
  // The only one who may embed this page is the app; what is sent is the note's own.
  window.parent.postMessage(message, "*");
}

/** The size the diagram draws at: Mermaid says `width="100%"` and gives a `viewBox`. */
function sizeOf(root: Element): { width: number; height: number } {
  const [, , width = 0, height = 0] = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width: Math.ceil(width), height: Math.ceil(height) }
    : { width: 0, height: 0 };
}

function describe(root: Element): string {
  const said = [":scope > title", ":scope > desc"]
    .map((part) => root.querySelector(part)?.textContent.trim() ?? "")
    .filter((part) => part !== "")
    .join(". ");
  return (said === "" ? "Diagram" : `Diagram: ${said}`).slice(
    0,
    MAX_DESCRIPTION,
  );
}

async function draw({ id, source, look }: DrawRequest): Promise<void> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // No drawing of its own for an error: the page shows the source and the reason.
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    logLevel: "fatal",
    theme: "base",
    themeVariables: {
      ...look.colors,
      darkMode: look.dark,
      fontFamily: FONT,
      // On a dark ground Mermaid's shadow reads as a glow (Design System).
      dropShadow: "none",
    },
    fontFamily: FONT,
  });
  try {
    const { svg } = await mermaid.render(`diagram-${String(id)}`, source);
    // An image must be XML, and labels are HTML inside `foreignObject`.
    const root = new DOMParser()
      .parseFromString(svg, "text/html")
      .querySelector("svg");
    if (root === null) {
      say({ kind: "failed", id, reason: "Mermaid gave no picture" });
      return;
    }
    const { width, height } = sizeOf(root);
    if (width > 0) {
      root.setAttribute("width", String(width));
      root.setAttribute("height", String(height));
    }
    say({
      kind: "drawn",
      id,
      svg: new XMLSerializer().serializeToString(root),
      width,
      height,
      description: describe(root),
    });
  } catch (reason) {
    say({
      kind: "failed",
      id,
      reason:
        reason instanceof Error ? reason.message : "Mermaid could not read it",
    });
  }
}

window.addEventListener("message", (event: MessageEvent<DrawRequest>) => {
  if (event.source === window.parent) {
    void draw(event.data);
  }
});

say({ kind: "ready" });
