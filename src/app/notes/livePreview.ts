import { syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { NoteImage, NoteLink } from "../../lib/ipc/commands";
import {
  blocksField,
  calloutOf,
  calloutOpen,
  liveBlocks,
  toggleCallout,
} from "./liveBlocks";
import { ImageWidget } from "./liveImages";
import {
  actionsOf,
  bodyStart,
  imagesIn,
  imagesOf,
  type ImagesOf,
  type LiveActions,
  linksIn,
  linksOf,
  type LinksOf,
} from "./liveShared";

// Live preview (M3-017, ADR-0020): notes read as formatted text while being edited,
// and an element's marks come back where the cursor is. This changes only the view:
// nothing here writes except a click on a task's checkbox, which is one normal edit.
// Lezer tells how the text looks; link targets keep coming from Rust, so a
// disagreement between the two parsers can change a look, never the file.

/** Whether the cursor or a selection touches this range: then its marks show. */
export function touched(
  selection: EditorSelection,
  from: number,
  to: number,
): boolean {
  return selection.ranges.some((range) => range.from <= to && range.to >= from);
}

class Bullet extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-bullet";
    bullet.textContent = "•";
    return bullet;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class Rule extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-rule";
    return rule;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Writes `[x]` or `[ ]` at a task marker as one normal edit, so it undoes and saves. */
function toggleTask(view: EditorView, from: number): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const marker = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(marker)) {
    return false;
  }
  view.dispatch({
    changes: {
      from: from + 1,
      to: from + 2,
      insert: marker === "[ ]" ? "x" : " ",
    },
    userEvent: "input",
  });
  return true;
}

class TaskBox extends WidgetType {
  constructor(
    private readonly done: boolean,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: TaskBox): boolean {
    return other.done === this.done && other.readOnly === this.readOnly;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.done;
    box.disabled = this.readOnly;
    box.tabIndex = -1;
    box.setAttribute("aria-label", this.done ? "Task, done" : "Task, open");
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    box.addEventListener("click", (event) => {
      event.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** What a callout without a title shows: its kind. */
class CalloutLabel extends WidgetType {
  constructor(private readonly kind: string) {
    super();
  }

  override eq(other: CalloutLabel): boolean {
    return other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.textContent = this.kind.charAt(0).toUpperCase() + this.kind.slice(1);
    return label;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Opens and closes a foldable callout (M3-018). Only the view changes. */
class FoldButton extends WidgetType {
  constructor(
    private readonly line: number,
    private readonly open: boolean,
  ) {
    super();
  }

  override eq(other: FoldButton): boolean {
    return other.line === this.line && other.open === this.open;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-fold";
    button.tabIndex = -1;
    button.textContent = this.open ? "\u25BE" : "\u25B8";
    button.setAttribute("aria-expanded", String(this.open));
    button.setAttribute(
      "aria-label",
      this.open ? "Close callout" : "Open callout",
    );
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      toggleCallout(view, view.state.doc.lineAt(view.posAtDOM(button)).from);
    });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });
const rule = Decoration.replace({ widget: new Rule() });
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const headingLine = (level: number) =>
  Decoration.line({ class: `cm-heading cm-heading-${String(level)}` });
const quoteLine = Decoration.line({ class: "cm-quote" });
const codeLine = Decoration.line({ class: "cm-code-block" });

/** The decorations for the visible part of a note. A plain function of the state, so
 *  tests run it without a view. */
export function previewRanges(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  links: readonly NoteLink[],
  focused = true,
  images: readonly NoteImage[] = [],
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  // Without focus there is no cursor to show marks for: a note that just opened has
  // its cursor at the start, and its first line should still read as formatted text.
  const near = (from: number, to: number) =>
    focused && touched(state.selection, from, to);
  const body = bodyStart(state);
  const lineStyled = new Set<string>();
  const done = new Set<string>();
  const tree = syntaxTree(state);

  const hidden = (from: number, to: number) => {
    if (to > from) {
      ranges.push(hide.range(from, to));
    }
  };
  /** A mark and the one space after it, as in `# Title`, `> text`. */
  const hiddenWithSpace = (from: number, to: number) => {
    hidden(from, state.sliceDoc(to, to + 1) === " " ? to + 1 : to);
  };
  const eachLine = (
    from: number,
    to: number,
    within: { from: number; to: number },
    decoration: Decoration,
    key: string,
  ) => {
    const start = Math.max(from, within.from);
    const end = Math.min(to, within.to);
    for (let at = start; at <= end;) {
      const line = state.doc.lineAt(at);
      const id = `${key}:${String(line.from)}`;
      if (!lineStyled.has(id)) {
        lineStyled.add(id);
        ranges.push(decoration.range(line.from));
      }
      at = line.to + 1;
    }
  };
  /** Only a link Rust accepts hides its source: `[x](javascript:…)` stays readable. */
  const accepted = (from: number, to: number) =>
    links.some(
      (link) =>
        link.from === from && link.to === to && link.target.state !== "other",
    );

  for (const part of visible) {
    tree.iterate({
      from: part.from,
      to: part.to,
      enter: (found) => {
        if (found.to <= body) {
          return false;
        }
        const node = found.node;
        const { from, to, name } = found;
        // A closed callout's body splits the visible part in two, and a node across
        // the gap comes twice: its decorations once, its children still walked.
        const id = `${name}:${String(from)}:${String(to)}`;
        if (done.has(id)) {
          return undefined;
        }
        done.add(id);
        const heading = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(name);
        if (heading !== null) {
          eachLine(from, to, part, headingLine(Number(heading[1])), "heading");
          const lineFrom = state.doc.lineAt(from).from;
          const lineTo = state.doc.lineAt(to).to;
          if (!near(lineFrom, lineTo)) {
            for (const mark of node.getChildren("HeaderMark")) {
              hiddenWithSpace(mark.from, mark.to);
            }
          }
          return undefined;
        }
        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
            if (!near(from, to)) {
              for (const mark of node.getChildren("EmphasisMark")) {
                hidden(mark.from, mark.to);
              }
            }
            return undefined;
          case "Strikethrough":
            if (!near(from, to)) {
              for (const mark of node.getChildren("StrikethroughMark")) {
                hidden(mark.from, mark.to);
              }
            }
            return undefined;
          case "InlineCode":
            ranges.push(inlineCode.range(from, to));
            if (!near(from, to)) {
              for (const mark of node.getChildren("CodeMark")) {
                hidden(mark.from, mark.to);
              }
            }
            return false;
          case "Link": {
            const marks = node.getChildren("LinkMark");
            if (marks.length >= 2 && accepted(from, to) && !near(from, to)) {
              hidden(marks[0].from, marks[0].to);
              hidden(marks[1].from, to);
            }
            return undefined;
          }
          case "Autolink":
            if (accepted(from, to) && !near(from, to)) {
              for (const mark of node.getChildren("LinkMark")) {
                hidden(mark.from, mark.to);
              }
            }
            return false;
          // Rust decides what shows, below; anything else stays as written.
          case "Image":
            return false;
          case "Blockquote": {
            const first = state.doc.lineAt(from);
            const callout = calloutOf(first.text);
            if (callout === null) {
              eachLine(from, to, part, quoteLine, "quote");
              return undefined;
            }
            eachLine(
              from,
              to,
              part,
              Decoration.line({
                class: `cm-callout cm-callout-${callout.look}`,
              }),
              "callout",
            );
            ranges.push(
              Decoration.line({ class: "cm-callout-title" }).range(first.from),
            );
            if (!near(first.from, first.to)) {
              const open = calloutOpen(state, first.from);
              const markerFrom = first.from + callout.markerFrom;
              let markerTo = first.from + callout.markerTo;
              if (state.sliceDoc(markerTo, markerTo + 1) === " ") {
                markerTo += 1;
              }
              const widgets: Range<Decoration>[] = [];
              if (open !== null) {
                widgets.push(
                  Decoration.widget({
                    widget: new FoldButton(first.from, open),
                    side: -1,
                  }).range(markerFrom),
                );
              }
              widgets.push(
                (callout.title === ""
                  ? Decoration.replace({
                      widget: new CalloutLabel(callout.kind),
                    })
                  : hide
                ).range(markerFrom, markerTo),
              );
              ranges.push(...widgets);
            }
            return undefined;
          }
          case "QuoteMark":
            if (!near(from, to)) {
              hiddenWithSpace(from, to);
            }
            return undefined;
          case "ListMark": {
            const item = node.parent;
            const task = node.nextSibling;
            const marker =
              task?.name === "Task" ? task.getChild("TaskMarker") : null;
            if (marker !== null) {
              if (!near(from, marker.to)) {
                hiddenWithSpace(from, to);
              }
            } else if (item?.parent?.name === "BulletList" && !near(from, to)) {
              ranges.push(bullet.range(from, to));
            }
            return undefined;
          }
          case "TaskMarker": {
            const start =
              node.parent?.parent?.getChild("ListMark")?.from ?? from;
            if (!near(start, to)) {
              const done = state.sliceDoc(from + 1, from + 2) !== " ";
              ranges.push(
                Decoration.replace({
                  widget: new TaskBox(done, state.readOnly),
                }).range(from, to),
              );
            }
            return undefined;
          }
          case "HorizontalRule": {
            const line = state.doc.lineAt(from);
            if (!near(line.from, line.to)) {
              ranges.push(rule.range(from, to));
            }
            return false;
          }
          case "FencedCode": {
            eachLine(from, to, part, codeLine, "code");
            if (!near(from, to)) {
              const marks = node.getChildren("CodeMark");
              // An unclosed block has only its opening fence.
              marks.forEach((mark, index) => {
                hidden(
                  mark.from,
                  index === 0 ? state.doc.lineAt(mark.from).to : mark.to,
                );
              });
            }
            return false;
          }
          case "CodeBlock":
            eachLine(from, to, part, codeLine, "code");
            return false;
          default:
            return undefined;
        }
      },
    });
  }

  // Wikilinks: Lezer does not know them, Rust found them. Only their text shows.
  for (const link of links) {
    if (
      link.target.state === "other" ||
      !visible.some((part) => link.from <= part.to && link.to >= part.from) ||
      near(link.from, link.to)
    ) {
      continue;
    }
    const text = state.sliceDoc(link.from, link.to);
    if (text.startsWith("[[") && text.endsWith("]]")) {
      const pipe = text.indexOf("|");
      hidden(link.from, link.from + (pipe < 0 ? 2 : pipe + 1));
      hidden(link.to - 2, link.to);
    }
  }

  // Images (M3-013): Rust found them. One written across two lines stays source: the
  // view plugin that makes these may not replace a line break.
  for (const image of images) {
    if (
      image.to > image.from &&
      image.to <= state.doc.length &&
      image.from >= body &&
      visible.some((part) => image.from <= part.to && image.to >= part.from) &&
      !near(image.from, image.to) &&
      state.doc.lineAt(image.from).to >= image.to
    ) {
      ranges.push(
        Decoration.replace({ widget: new ImageWidget(image) }).range(
          image.from,
          image.to,
        ),
      );
    }
  }
  return ranges;
}

/** After a mouse drag: the decorations held still during it come up to date. */
const dragEnded = StateEffect.define();

const previewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    dragging = false;
    private readonly view: EditorView;
    private readonly mouseUp = () => {
      if (this.dragging) {
        this.dragging = false;
        this.view.dispatch({ effects: dragEnded.of(null) });
      }
    };
    /** An image's real size is known only now; CodeMirror must measure again. */
    private readonly imageSettled = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        this.view.requestMeasure();
      }
    };

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.build(view.state);
      window.addEventListener("mouseup", this.mouseUp);
      // These do not bubble, so on the way down; also for images in table cells.
      view.contentDOM.addEventListener("load", this.imageSettled, true);
      view.contentDOM.addEventListener("error", this.imageSettled, true);
    }

    build(state: EditorState): DecorationSet {
      return Decoration.set(
        previewRanges(
          state,
          this.view.visibleRanges,
          linksIn(state),
          this.view.hasFocus,
          imagesIn(state),
        ),
        true,
      );
    }

    update(update: ViewUpdate) {
      const stale =
        update.docChanged ||
        update.viewportChanged ||
        update.focusChanged ||
        linksIn(update.state) !== linksIn(update.startState) ||
        imagesIn(update.state) !== imagesIn(update.startState) ||
        // A callout opened or closed: its button shows the other way now.
        update.state.field(blocksField, false) !==
          update.startState.field(blocksField, false) ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.startState.readOnly !== update.state.readOnly ||
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(dragEnded)),
        );
      // A selection being dragged does not reveal marks yet, or the text would jump
      // under the mouse.
      if (stale || (update.selectionSet && !this.dragging)) {
        this.decorations = this.build(update.state);
      }
    }

    destroy() {
      window.removeEventListener("mouseup", this.mouseUp);
      this.view.contentDOM.removeEventListener("load", this.imageSettled, true);
      this.view.contentDOM.removeEventListener(
        "error",
        this.imageSettled,
        true,
      );
    }
  },
  {
    decorations: (value) => value.decorations,
    eventHandlers: {
      mousedown(event) {
        if (event.button === 0) {
          this.dragging = true;
        }
      },
    },
  },
);

/** The extension; `source` and `images` give Rust's findings for a state. */
export function livePreview(
  source: LinksOf,
  images: ImagesOf,
  actions: LiveActions,
): Extension {
  return [
    linksOf.of(source),
    imagesOf.of(images),
    actionsOf.of(actions),
    previewPlugin,
    liveBlocks(),
  ];
}

export function livePreviewOn(view: EditorView): boolean {
  return view.plugin(previewPlugin) !== null;
}

/** Ctrl + Enter on a task's line. */
export function toggleTaskAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const markers: number[] = [];
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "TaskMarker") {
        markers.push(node.from);
      }
    },
  });
  return markers.length > 0 && toggleTask(view, markers[0]);
}
