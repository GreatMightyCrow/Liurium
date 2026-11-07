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
import type katexModule from "katex";
import type { KatexOptions } from "katex";
import type { NoteMath } from "../../lib/ipc/commands";
import {
  bodyStart,
  dragEnded,
  enterBlock,
  mathIn,
  touched,
} from "./liveShared";

// Formulas in live preview (M3-010, ADR-0020). A formula's text is untrusted and KaTeX
// is a large parser, so it only ever gets text and gives back DOM nodes: every option
// is set in one place below, nothing can reach an address, a file, or a command, and
// nothing goes to the console. The source stays what is saved; nothing here writes.

type Katex = typeof katexModule;
type Macros = NonNullable<KatexOptions["macros"]>;

/** These print a formula's text to the console, and notes stay out of logs. As macros
 *  that do nothing they also stay away through `\let`, which copies a macro. */
const SILENT: Macros = {
  "\\message": { tokens: [], numArgs: 1 },
  "\\errmessage": { tokens: [], numArgs: 1 },
  "\\show": { tokens: [], numArgs: 1 },
};

/** Every option in one place. `macros` is written to by what the formula defines. */
export function mathOptions(display: boolean, macros: Macros): KatexOptions {
  return {
    displayMode: display,
    // No `\href`, `\url`, `\includegraphics`, `\htmlClass`, and the like.
    trust: false,
    // A formula KaTeX refuses shows its source; its own error span needs a style
    // attribute, which the CSP blocks.
    throwOnError: true,
    // "warn" names input in the console.
    strict: "ignore",
    // `\rule{500em}{500em}` would cover the window.
    maxSize: 20,
    maxExpand: 1000,
    // MathML for screen readers.
    output: "htmlAndMathml",
    // What a formula defines stays in `macros`, for the formulas below it.
    globalGroup: true,
    macros,
  };
}

interface Loaded {
  katex: Katex;
  /** KaTeX's CSS without its fonts: rules for fonts do not work in a shadow root, so
   *  those are in `src/styles/katexFonts.css`. */
  css: string;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

/** KaTeX comes with the first formula, so a note without one costs nothing. */
export function loadMath(): Promise<Loaded> {
  loading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css?raw"),
  ])
    .then(async ([module, styles]) => {
      // It adds `\ce` and `\pu` to the KaTeX it imports.
      await import("katex/contrib/mhchem");
      loaded = {
        katex: module.default,
        css: styles.default.replace(/@font-face\s*\{[^}]*\}/g, ""),
      };
      return loaded;
    })
    .catch((reason: unknown) => {
      // It may work when the next formula asks.
      loading = null;
      throw reason;
    });
  return loading;
}

const sheets = new WeakMap<Loaded, CSSStyleSheet>();

/** Puts KaTeX's CSS into the root the editor lives in, as a constructed style sheet,
 *  which the strict CSP allows. */
function adoptStyles(root: DocumentOrShadowRoot, math: Loaded): void {
  if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
    return;
  }
  let sheet = sheets.get(math);
  if (sheet === undefined) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(math.css);
    sheets.set(math, sheet);
  }
  if (!root.adoptedStyleSheets.includes(sheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
}

/** What can define something for the formulas below it. */
const DEFINES =
  /\\(?:def|gdef|edef|xdef|let|futurelet|global|long|newcommand|renewcommand|providecommand)(?![A-Za-z])/;
/** Beyond these a note's definitions are not shared, which caps the work per note. */
const MAX_DEFINERS = 200;
const MAX_DEFINER_LENGTH = 100_000;

/** The formulas of a note that define something, in the order of the text. */
export function definersIn(all: readonly NoteMath[]): readonly NoteMath[] {
  const found: NoteMath[] = [];
  let length = 0;
  for (const math of all) {
    if (DEFINES.test(math.tex)) {
      length += math.tex.length;
      if (found.length >= MAX_DEFINERS || length > MAX_DEFINER_LENGTH) {
        break;
      }
      found.push(math);
    }
  }
  return found;
}

/** What a formula at `from` sees: the definitions above it in the same note, so what
 *  shows does not depend on what has been scrolled to. */
export function definersBefore(
  definers: readonly NoteMath[],
  from: number,
): readonly string[] {
  return definers.filter((each) => each.from < from).map((each) => each.tex);
}

/** Tables built so far, one step per definition, so a redraw costs nothing. */
interface TableStep {
  macros: Macros;
  next: Map<string, TableStep>;
}

const MAX_TABLE_STEPS = 1000;
let firstStep: TableStep = { macros: SILENT, next: new Map() };
let tableSteps = 0;

function tableFor(katex: Katex, definers: readonly string[]): Macros {
  if (tableSteps >= MAX_TABLE_STEPS) {
    firstStep = { macros: SILENT, next: new Map() };
    tableSteps = 0;
  }
  let step = firstStep;
  for (const tex of definers) {
    let next = step.next.get(tex);
    if (next === undefined) {
      const macros = { ...step.macros };
      try {
        katex.render(
          tex,
          document.createElement("span"),
          // Display mode, which refuses nothing that inline mode allows.
          mathOptions(true, macros),
        );
      } catch {
        // What it defined before its mistake stays; it shows as an error of its own.
      }
      next = { macros, next: new Map() };
      step.next.set(tex, next);
      tableSteps += 1;
    }
    step = next;
  }
  return step.macros;
}

/** Why a formula does not show. A stack overflow from deep nesting also comes here. */
function reasonOf(katex: Katex, reason: unknown): string {
  return reason instanceof katex.ParseError
    ? reason.rawMessage
    : "This formula could not be read";
}

function showSource(element: HTMLElement, math: NoteMath, why: string): void {
  element.classList.add("cm-math-error");
  element.textContent = math.tex;
  element.title = `Formula not shown: ${why}`;
}

function draw(
  { katex }: Loaded,
  element: HTMLElement,
  math: NoteMath,
  definers: readonly string[],
): void {
  const drawn = document.createElement("span");
  try {
    katex.render(
      math.tex,
      drawn,
      // A copy: only formulas above share what they define.
      mathOptions(math.display, { ...tableFor(katex, definers) }),
    );
    element.replaceChildren(...drawn.childNodes);
  } catch (reason) {
    showSource(element, math, reasonOf(katex, reason));
  }
}

/** The formula, or its source until KaTeX is there and if KaTeX refuses it. */
export function mathElement(
  math: NoteMath,
  definers: readonly string[],
  drawnLater?: () => void,
): HTMLElement {
  const element = document.createElement("span");
  element.className = math.display ? "cm-math cm-math-display" : "cm-math";
  if (loaded !== null) {
    draw(loaded, element, math, definers);
    return element;
  }
  element.textContent = math.tex;
  loadMath().then(
    (now) => {
      draw(now, element, math, definers);
      drawnLater?.();
    },
    () => {
      showSource(element, math, "the formula module could not be loaded");
      drawnLater?.();
    },
  );
  return element;
}

/** What makes two formulas look the same; their place in the text does not count. */
export function mathKey(math: NoteMath, definers: readonly string[]): string {
  return JSON.stringify([math.tex, math.display, definers]);
}

export class MathWidget extends WidgetType {
  private readonly key: string;

  constructor(
    private readonly math: NoteMath,
    private readonly definers: readonly string[],
    private readonly block = false,
  ) {
    super();
    this.key = `${mathKey(math, definers)}${String(block)}`;
  }

  override eq(other: MathWidget): boolean {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = mathElement(this.math, this.definers, () => {
      view.requestMeasure();
    });
    if (this.block) {
      element.classList.add("cm-math-block");
    }
    return element;
  }

  // A click places the cursor here, which brings the source back.
  override ignoreEvent(): boolean {
    return false;
  }
}

/** A `$$` block that fills its lines, at the top level: a block widget. In lists and
 *  quotes it stays source, as tables do there. */
function isBlock(state: EditorState, math: NoteMath, body: number): boolean {
  if (
    !math.display ||
    math.from < body ||
    math.to > state.doc.length ||
    math.to <= math.from
  ) {
    return false;
  }
  const first = state.doc.lineAt(math.from);
  const last = state.doc.lineAt(math.to);
  if (
    first.number === last.number ||
    first.from !== math.from ||
    last.to !== math.to
  ) {
    return false;
  }
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      state,
    ).resolveInner(math.from, 1);
    node !== null;
    node = node.parent
  ) {
    if (node.name === "Blockquote" || node.name === "ListItem") {
      return false;
    }
  }
  return true;
}

interface MathBlocks {
  focused: boolean;
  /** The ones that show as a block now. */
  blocks: readonly { from: number; to: number }[];
  marks: DecorationSet;
}

export const setFocused = StateEffect.define<boolean>();

function buildBlocks(state: EditorState, focused: boolean): MathBlocks {
  const all = mathIn(state);
  const definers = definersIn(all);
  const body = bodyStart(state);
  const ranges: Range<Decoration>[] = [];
  const blocks: { from: number; to: number }[] = [];
  for (const math of all) {
    if (
      isBlock(state, math, body) &&
      !(focused && touched(state.selection, math.from, math.to))
    ) {
      blocks.push({ from: math.from, to: math.to });
      ranges.push(
        Decoration.replace({
          widget: new MathWidget(
            math,
            definersBefore(definers, math.from),
            true,
          ),
          block: true,
        }).range(math.from, math.to),
      );
    }
  }
  return { focused, blocks, marks: Decoration.set(ranges, true) };
}

/** Block decorations must come from a state field. */
export const mathBlocksField = StateField.define<MathBlocks>({
  create: (state) => buildBlocks(state, false),
  update(value, transaction) {
    const { state, startState } = transaction;
    let focused = value.focused;
    let dropped = false;
    for (const effect of transaction.effects) {
      if (effect.is(setFocused)) {
        focused = effect.value;
      } else if (effect.is(dragEnded)) {
        dropped = true;
      }
    }
    const stale =
      dropped ||
      focused !== value.focused ||
      transaction.docChanged ||
      state.readOnly !== startState.readOnly ||
      mathIn(state) !== mathIn(startState) ||
      syntaxTree(state) !== syntaxTree(startState);
    // A selection being dragged does not reveal a source yet, or the text would jump
    // under the mouse.
    const dragging =
      transaction.isUserEvent("select.pointer") &&
      !transaction.newSelection.main.empty;
    if (!stale && (transaction.selection === undefined || dragging)) {
      return value;
    }
    return buildBlocks(state, focused);
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.marks),
});

/** Loads KaTeX and its CSS once a note has a formula. */
const mathLoader = ViewPlugin.define((view) => {
  const prepare = (state: EditorState) => {
    if (mathIn(state).length > 0) {
      loadMath().then(
        (math) => {
          adoptStyles(view.root, math);
        },
        () => {
          // Each formula says so where it stands.
        },
      );
    }
  };
  prepare(view.state);
  return {
    update(update) {
      if (mathIn(update.state) !== mathIn(update.startState)) {
        prepare(update.state);
      }
    },
  };
});

export function liveMath(): Extension {
  return [
    mathBlocksField,
    EditorView.focusChangeEffect.of((_state, focusing) =>
      setFocused.of(focusing),
    ),
    mathLoader,
    Prec.high(
      keymap.of([
        {
          key: "ArrowDown",
          run: (view) =>
            enterBlock(view, true, view.state.field(mathBlocksField).blocks),
        },
        {
          key: "ArrowUp",
          run: (view) =>
            enterBlock(view, false, view.state.field(mathBlocksField).blocks),
        },
      ]),
    ),
  ];
}
