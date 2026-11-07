import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DiagramLook } from "../../diagramFrame/protocol";
import { type DiagramResult, drawDiagram, drawnBefore } from "./diagramDrawing";
import { setFocused } from "./liveMath";
import { bodyStart, dragEnded, enterBlock, touched } from "./liveShared";

// Diagrams in live preview (M3-011, ADR-0021): a `mermaid` code block shows as a picture,
// and its source returns at the cursor. Nothing here writes; the source stays what is
// saved. A block in a list or a quote stays source, as tables do there.

/** Mermaid's name for a color, Liurium's token, and what a contrast theme gives it. */
const COLORS: readonly (readonly [string, string, "Canvas" | "CanvasText"])[] =
  [
    ["background", "--color-canvas", "Canvas"],
    ["mainBkg", "--color-surface-elevated", "Canvas"],
    ["primaryColor", "--color-surface-elevated", "Canvas"],
    ["primaryTextColor", "--color-text", "CanvasText"],
    ["primaryBorderColor", "--color-border-control", "CanvasText"],
    ["secondaryColor", "--color-accent-muted", "Canvas"],
    ["secondaryTextColor", "--color-text", "CanvasText"],
    ["secondaryBorderColor", "--color-accent", "CanvasText"],
    ["tertiaryColor", "--color-surface", "Canvas"],
    ["tertiaryTextColor", "--color-text", "CanvasText"],
    ["tertiaryBorderColor", "--color-border", "CanvasText"],
    ["nodeBorder", "--color-border-control", "CanvasText"],
    ["clusterBkg", "--color-surface", "Canvas"],
    ["clusterBorder", "--color-border", "CanvasText"],
    ["edgeLabelBackground", "--color-surface", "Canvas"],
    ["lineColor", "--color-text-secondary", "CanvasText"],
    ["textColor", "--color-text", "CanvasText"],
    ["titleColor", "--color-text", "CanvasText"],
    ["noteBkgColor", "--color-accent-muted", "Canvas"],
    ["noteTextColor", "--color-text", "CanvasText"],
    ["noteBorderColor", "--color-accent", "CanvasText"],
  ];

/** A system color as Mermaid can read it. */
function systemColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = name;
  document.body.append(probe);
  const { color } = getComputedStyle(probe);
  probe.remove();
  return color;
}

/** The tokens' values now: a picture cannot use the page's variables. */
export function currentLook(): DiagramLook {
  const root = document.documentElement;
  const forced = window.matchMedia("(forced-colors: active)").matches;
  const tokens = getComputedStyle(root);
  const colors: Record<string, string> = {};
  for (const [name, token, system] of COLORS) {
    const value = forced
      ? systemColor(system)
      : tokens.getPropertyValue(token).trim();
    if (value !== "") {
      colors[name] = value;
    }
  }
  return { dark: root.dataset.mode !== "light", colors };
}

export interface DiagramBlock {
  from: number;
  to: number;
  source: string;
}

/** The closed `mermaid` code blocks at the top level, in the order of the text. */
export function diagramsIn(state: EditorState): DiagramBlock[] {
  const found: DiagramBlock[] = [];
  const body = bodyStart(state);
  const cursor = syntaxTree(state).cursor();
  if (!cursor.firstChild()) {
    return found;
  }
  do {
    if (cursor.name === "FencedCode" && cursor.from >= body) {
      const node = cursor.node;
      const info = node.getChild("CodeInfo");
      if (
        node.getChildren("CodeMark").length === 2 &&
        info !== null &&
        state.sliceDoc(info.from, info.to).trim() === "mermaid"
      ) {
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        // Otherwise it is empty: nothing to draw.
        if (last.number > first.number + 1) {
          found.push({
            from: first.from,
            to: last.to,
            source: state.sliceDoc(first.to + 1, last.from - 1),
          });
        }
      }
    }
  } while (cursor.nextSibling());
  return found;
}

function showSource(box: HTMLElement, source: string, reason?: string): void {
  const text = document.createElement("div");
  text.className = "cm-diagram-source";
  text.textContent = source;
  if (reason !== undefined) {
    text.classList.add("cm-diagram-error");
    text.title = `Diagram not shown: ${reason}`;
  }
  box.replaceChildren(text);
}

function show(box: HTMLElement, source: string, result: DiagramResult): void {
  if (result.kind === "failed") {
    showSource(box, source, result.reason);
    return;
  }
  const image = document.createElement("img");
  image.className = "cm-diagram-image";
  image.alt = result.description;
  image.draggable = false;
  if (result.width > 0) {
    image.width = result.width;
    image.height = result.height;
  }
  image.addEventListener("error", () => {
    showSource(box, source, "The picture could not be shown");
  });
  image.src = result.address;
  box.replaceChildren(image);
}

export class DiagramWidget extends WidgetType {
  private readonly key: string;

  constructor(
    private readonly source: string,
    private readonly look: DiagramLook,
  ) {
    super();
    this.key = JSON.stringify([source, look]);
  }

  override eq(other: DiagramWidget): boolean {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    // A box that stays: CodeMirror puts back a widget's root if it is replaced (M3-019).
    const box = document.createElement("div");
    box.className = "cm-diagram";
    const known = drawnBefore(this.source, this.look);
    if (known !== undefined) {
      show(box, this.source, known);
      return box;
    }
    showSource(box, this.source);
    void drawDiagram(this.source, this.look).then((result) => {
      show(box, this.source, result);
      view.requestMeasure();
    });
    return box;
  }

  // A click places the cursor here, which brings the source back.
  override ignoreEvent(): boolean {
    return false;
  }
}

interface Diagrams {
  focused: boolean;
  look: DiagramLook;
  /** The ones that show as a picture now. */
  blocks: readonly DiagramBlock[];
  marks: DecorationSet;
}

export const setDiagramLook = StateEffect.define<DiagramLook>();

function buildDiagrams(
  state: EditorState,
  focused: boolean,
  look: DiagramLook,
): Diagrams {
  const blocks: DiagramBlock[] = [];
  const ranges: Range<Decoration>[] = [];
  for (const block of diagramsIn(state)) {
    if (!(focused && touched(state.selection, block.from, block.to))) {
      blocks.push(block);
      ranges.push(
        Decoration.replace({
          widget: new DiagramWidget(block.source, look),
          block: true,
        }).range(block.from, block.to),
      );
    }
  }
  return { focused, look, blocks, marks: Decoration.set(ranges, true) };
}

/** Block decorations must come from a state field. */
export const diagramsField = StateField.define<Diagrams>({
  create: (state) => buildDiagrams(state, false, currentLook()),
  update(value, transaction) {
    const { state, startState } = transaction;
    let { focused, look } = value;
    let dropped = false;
    for (const effect of transaction.effects) {
      if (effect.is(setFocused)) {
        focused = effect.value;
      } else if (effect.is(setDiagramLook)) {
        look = effect.value;
      } else if (effect.is(dragEnded)) {
        dropped = true;
      }
    }
    const stale =
      dropped ||
      focused !== value.focused ||
      look !== value.look ||
      transaction.docChanged ||
      syntaxTree(state) !== syntaxTree(startState);
    // A selection being dragged does not reveal a source yet, or the text would jump
    // under the mouse.
    const dragging =
      transaction.isUserEvent("select.pointer") &&
      !transaction.newSelection.main.empty;
    if (!stale && (transaction.selection === undefined || dragging)) {
      return value;
    }
    return buildDiagrams(state, focused, look);
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.marks),
});

/** Whether the block at `from` shows as a picture, so live preview leaves it alone. */
export const diagramShownAt = (state: EditorState, from: number): boolean =>
  state
    .field(diagramsField, false)
    ?.blocks.some((block) => block.from === from) ?? false;

/** Draws again when the theme, the mode, or a contrast theme changes. */
const lookWatcher = ViewPlugin.define((view) => {
  const check = () => {
    const next = currentLook();
    if (
      JSON.stringify(next) !==
      JSON.stringify(view.state.field(diagramsField).look)
    ) {
      view.dispatch({ effects: setDiagramLook.of(next) });
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-accent", "data-base", "data-mode"],
  });
  const media = [
    window.matchMedia("(forced-colors: active)"),
    window.matchMedia("(prefers-color-scheme: light)"),
  ];
  for (const each of media) {
    each.addEventListener("change", check);
  }
  return {
    destroy() {
      observer.disconnect();
      for (const each of media) {
        each.removeEventListener("change", check);
      }
    },
  };
});

export function liveDiagrams(): Extension {
  const blocksOf = (view: EditorView) => view.state.field(diagramsField).blocks;
  return [
    diagramsField,
    lookWatcher,
    Prec.high(
      keymap.of([
        {
          key: "ArrowDown",
          run: (view) => enterBlock(view, true, blocksOf(view)),
        },
        {
          key: "ArrowUp",
          run: (view) => enterBlock(view, false, blocksOf(view)),
        },
      ]),
    ),
  ];
}
