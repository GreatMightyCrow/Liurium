import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { DiagramLook } from "../../diagramFrame/protocol";
import { axeViolations } from "../../test/axe";
import type { DiagramResult } from "./diagramDrawing";
import {
  currentLook,
  diagramShownAt,
  diagramsField,
  diagramsIn,
  DiagramWidget,
  liveDiagrams,
  setDiagramLook,
} from "./liveDiagrams";
import { setFocused } from "./liveMath";
import { dragEnded } from "./liveShared";

const drawing = vi.hoisted(() => ({
  drawDiagram: vi.fn<(source: string) => Promise<DiagramResult>>(),
  drawnBefore: vi.fn<(source: string) => DiagramResult | undefined>(),
}));
vi.mock("./diagramDrawing", () => drawing);

const LOOK: DiagramLook = { dark: true, colors: {} };

const FENCE = "```mermaid\nflowchart TD\n  A --> B\n```";

const DRAWN: DiagramResult = {
  kind: "drawn",
  address: "blob:picture",
  width: 120,
  height: 80,
  description: "Diagram: Plan",
};

function stateOf(doc: string, selection?: number) {
  const state = EditorState.create({
    doc,
    selection: selection === undefined ? undefined : { anchor: selection },
    extensions: [
      markdown({ base: markdownLanguage }),
      liveDiagrams(),
      EditorView.contentAttributes.of({ "aria-label": "Note" }),
    ],
  });
  ensureSyntaxTree(state, doc.length, 1000);
  return state;
}

/** The state again, once the whole text is parsed and with focus as asked. */
function ready(doc: string, selection: number, focused: boolean) {
  const first = stateOf(doc, selection);
  return first.update({ effects: setFocused.of(focused) }).state;
}

function stubMedia(forced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: forced && query.includes("forced-colors"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  stubMedia(false);
  drawing.drawDiagram.mockReset();
  drawing.drawnBefore.mockReset();
  drawing.drawDiagram.mockImplementation(() => new Promise(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.mode;
});

describe("finding", () => {
  test("a closed mermaid block at the top level, with its exact text", () => {
    const doc = `before\n\n${FENCE}\n\nafter`;
    expect(diagramsIn(stateOf(doc))).toEqual([
      {
        from: 8,
        to: 8 + FENCE.length,
        source: "flowchart TD\n  A --> B",
      },
    ]);
  });

  test("each of several, in the order of the text", () => {
    const doc = "```mermaid\none\n```\n\n```mermaid\ntwo\n```";
    expect(diagramsIn(stateOf(doc)).map((each) => each.source)).toEqual([
      "one",
      "two",
    ]);
  });

  test.each([
    ["another language", "```js\nflowchart TD\n```"],
    ["no language", "```\nflowchart TD\n```"],
    ["other capitals", "```Mermaid\nflowchart TD\n```"],
    ["more words", "```mermaid extra\nflowchart TD\n```"],
    ["not closed", "```mermaid\nflowchart TD"],
    ["not closed, with more lines", "```mermaid\nflowchart TD\n  A --> B"],
    ["nothing inside", "```mermaid\n```"],
    ["in a quote", "> ```mermaid\n> flowchart TD\n> ```"],
    ["in a list", "- ```mermaid\n  flowchart TD\n  ```"],
    ["only indented", "    ```mermaid\n    flowchart TD\n    ```"],
    ["in a sentence", "the word `mermaid` here"],
  ])("%s stays code", (_name, doc) => {
    expect(diagramsIn(stateOf(doc))).toEqual([]);
  });

  test("the front matter is not Markdown", () => {
    const doc = "---\n```mermaid\nnot this\n```\n---\n\n```mermaid\none\n```";
    expect(diagramsIn(stateOf(doc)).map((each) => each.source)).toEqual([
      "one",
    ]);
  });

  test("an empty document", () => {
    expect(diagramsIn(stateOf(""))).toEqual([]);
  });
});

describe("showing", () => {
  const doc = `line\n\n${FENCE}\n\nend`;
  const inside = 12;
  const shown = (state: EditorState) => state.field(diagramsField).blocks;

  test("shows as a block where the cursor is not", () => {
    const state = ready(doc, 0, true);
    expect(shown(state)).toHaveLength(1);
    expect(diagramShownAt(state, 6)).toBe(true);
    let widget: unknown;
    let block: boolean | undefined;
    state.field(diagramsField).marks.between(0, doc.length, (_f, _t, value) => {
      const spec = value.spec as { widget: unknown; block: boolean };
      widget = spec.widget;
      block = spec.block;
    });
    expect(widget).toBeInstanceOf(DiagramWidget);
    expect(block).toBe(true);
  });

  test("the source returns at the cursor, and live preview gets it back", () => {
    const state = ready(doc, inside, true);
    expect(shown(state)).toEqual([]);
    expect(diagramShownAt(state, 6)).toBe(false);
  });

  test("the source also returns at either end of the block", () => {
    expect(shown(ready(doc, 6, true))).toEqual([]);
    expect(shown(ready(doc, 6 + FENCE.length, true))).toEqual([]);
  });

  test("an editor without focus keeps its picture", () => {
    expect(shown(ready(doc, inside, false))).toHaveLength(1);
  });

  test("moving the cursor in and out changes it, typing moves it along", () => {
    let state = ready(doc, 0, true);
    state = state.update({ selection: { anchor: inside } }).state;
    expect(shown(state)).toEqual([]);
    state = state.update({ selection: { anchor: 0 } }).state;
    expect(shown(state)).toHaveLength(1);
    state = state.update({
      changes: { from: 0, insert: "more " },
      selection: { anchor: 0 },
    }).state;
    expect(shown(state)[0]?.from).toBe(11);
  });

  test("a selection being dragged reveals nothing until it ends", () => {
    let state = ready(doc, 0, true);
    state = state.update({
      selection: EditorSelection.single(0, inside),
      userEvent: "select.pointer",
    }).state;
    expect(shown(state)).toHaveLength(1);
    state = state.update({ effects: dragEnded.of(null) }).state;
    expect(shown(state)).toEqual([]);
  });

  test("a new look gives the same text a new picture", () => {
    const first = new DiagramWidget("a", LOOK);
    expect(first.eq(new DiagramWidget("a", { ...LOOK }))).toBe(true);
    expect(first.eq(new DiagramWidget("a", { ...LOOK, dark: false }))).toBe(
      false,
    );
    expect(
      first.eq(new DiagramWidget("a", { dark: true, colors: { a: "#000" } })),
    ).toBe(false);
    expect(first.eq(new DiagramWidget("b", LOOK))).toBe(false);

    const state = ready(doc, 0, true);
    const next = { dark: false, colors: { background: "#fff" } };
    const after = state.update({ effects: setDiagramLook.of(next) }).state;
    expect(after.field(diagramsField).look).toBe(next);
    expect(after.field(diagramsField).marks).not.toBe(
      state.field(diagramsField).marks,
    );
  });

  test("nothing else builds it anew", () => {
    const state = ready(doc, 0, true);
    const after = state.update({ effects: [] }).state;
    expect(after.field(diagramsField)).toBe(state.field(diagramsField));
  });
});

describe("the look", () => {
  test("comes from the current tokens", () => {
    const root = document.documentElement;
    root.style.setProperty("--color-canvas", " #101010 ");
    root.style.setProperty("--color-text", "#f0f0f0");
    root.dataset.mode = "dark";

    const look = currentLook();

    expect(look.dark).toBe(true);
    expect(look.colors.background).toBe("#101010");
    expect(look.colors.textColor).toBe("#f0f0f0");
    // A token that is not set is left to Mermaid.
    expect(look.colors).not.toHaveProperty("noteBorderColor");
  });

  test("light mode says so", () => {
    document.documentElement.dataset.mode = "light";
    expect(currentLook().dark).toBe(false);
  });

  test("a contrast theme gives its own colors, not the tokens", () => {
    stubMedia(true);
    const seen: string[] = [];
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = (element as HTMLElement).style.color;
      if (style !== "") {
        seen.push(style);
        return { color: `resolved ${style}` } as CSSStyleDeclaration;
      }
      return original(element);
    });
    document.documentElement.style.setProperty("--color-canvas", "#101010");

    const { colors } = currentLook();

    expect(colors.background).toBe("resolved canvas");
    expect(colors.textColor).toBe("resolved canvastext");
    expect(seen.length).toBeGreaterThan(0);
    // The elements used to read them are gone again.
    expect(document.body.querySelectorAll("span")).toHaveLength(0);
  });
});

describe("in a real editor", () => {
  /** A real editor: it puts back what it thinks is its own (found by E2E, M3-019). */
  function editorWith(doc: string) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: stateOf(doc, 0),
    });
    return {
      view,
      content: view.contentDOM,
      done: () => {
        view.destroy();
        parent.remove();
      },
    };
  }
  const settled = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

  // jsdom has no layout, and the editor measures after each change.
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  test("the source stands in until the picture is there, which then stays", async () => {
    let finish: (result: DiagramResult) => void = () => undefined;
    drawing.drawDiagram.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { content, done } = editorWith(`a\n\n${FENCE}\n\nb`);
    try {
      expect(content.querySelector(".cm-diagram-source")?.textContent).toBe(
        "flowchart TD\n  A --> B",
      );
      expect(content.querySelector(".cm-diagram-error")).toBeNull();
      expect(content.querySelector("img")).toBeNull();

      finish(DRAWN);
      await settled();

      const image = content.querySelector<HTMLImageElement>(
        ".cm-diagram img.cm-diagram-image",
      );
      expect(image?.getAttribute("src")).toBe("blob:picture");
      expect(image?.alt).toBe("Diagram: Plan");
      expect(image?.getAttribute("width")).toBe("120");
      expect(image?.getAttribute("height")).toBe("80");
      expect(content.querySelector(".cm-diagram-source")).toBeNull();
    } finally {
      done();
    }
  });

  test("a diagram drawn before shows at once", () => {
    drawing.drawnBefore.mockReturnValue(DRAWN);
    const { content, done } = editorWith(FENCE);
    try {
      expect(content.querySelector("img")?.getAttribute("src")).toBe(
        "blob:picture",
      );
      expect(drawing.drawDiagram).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  test("a picture with no size of its own keeps the browser's", async () => {
    drawing.drawDiagram.mockResolvedValue({ ...DRAWN, width: 0, height: 0 });
    const { content, done } = editorWith(FENCE);
    try {
      await settled();
      expect(content.querySelector("img")?.hasAttribute("width")).toBe(false);
    } finally {
      done();
    }
  });

  test("a diagram that fails shows its source and says why, as text only", async () => {
    drawing.drawDiagram.mockResolvedValue({
      kind: "failed",
      reason: "<b>Parse error</b>",
    });
    const { content, done } = editorWith(FENCE);
    try {
      await settled();
      const error = content.querySelector<HTMLElement>(".cm-diagram-error");
      expect(error?.textContent).toBe("flowchart TD\n  A --> B");
      expect(error?.title).toBe("Diagram not shown: <b>Parse error</b>");
      expect(content.querySelector("b")).toBeNull();
      expect(content.querySelector("img")).toBeNull();
    } finally {
      done();
    }
  });

  test("a picture that does not load becomes its source, and stays so", async () => {
    drawing.drawDiagram.mockResolvedValue(DRAWN);
    const { content, done } = editorWith(FENCE);
    try {
      await settled();
      content.querySelector("img")?.dispatchEvent(new Event("error"));
      await settled();
      expect(content.querySelector("img")).toBeNull();
      expect(
        content.querySelector<HTMLElement>(".cm-diagram-error")?.title,
      ).toBe("Diagram not shown: The picture could not be shown");
    } finally {
      done();
    }
  });

  test("source text in markup stays text", async () => {
    const doc = "```mermaid\n<img src=x onerror=y>\n```";
    drawing.drawDiagram.mockResolvedValue({ kind: "failed", reason: "no" });
    const { content, done } = editorWith(doc);
    try {
      await settled();
      expect(content.querySelector("img")).toBeNull();
      expect(content.querySelector(".cm-diagram-error")?.textContent).toBe(
        "<img src=x onerror=y>",
      );
    } finally {
      done();
    }
  });

  test("a picture and an error pass axe", async () => {
    drawing.drawDiagram.mockImplementation((source) =>
      Promise.resolve(
        source === "one" ? DRAWN : { kind: "failed", reason: "no" },
      ),
    );
    const { done } = editorWith("```mermaid\none\n```\n\n```mermaid\ntwo\n```");
    try {
      await settled();
      const main = document.createElement("main");
      main.append(...document.body.children);
      document.body.append(main);
      expect(await axeViolations()).toEqual([]);
    } finally {
      done();
      document.body.replaceChildren();
    }
  });
});
