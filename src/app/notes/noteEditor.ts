import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
} from "@codemirror/view";
import type { NoteLink, NoteTag } from "../../lib/ipc/commands";
import { tags } from "@lezer/highlight";

// The note editor (ADR-0020): CodeMirror as the engine, everything visible from
// Liurium's tokens. It lives in a shadow root: there CodeMirror's styles become
// constructed style sheets, which the strict CSP allows; in the page itself its
// <style> elements would be blocked. Tokens are CSS custom properties, which
// reach into the shadow root; CSS Modules do not, so the look is set here.

const theme = EditorView.theme({
  "&": {
    // Grows with its text: the note and the properties box scroll together (M3-015).
    minHeight: "100%",
    color: "var(--color-text)",
    backgroundColor: "var(--color-canvas)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--font-size-md)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: "var(--line-height-base)",
  },
  ".cm-content": {
    maxWidth: "var(--size-note-measure)",
    padding: "var(--space-5)",
    caretColor: "var(--color-accent-text)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "var(--focus-ring-width) solid var(--color-accent-text)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--color-accent-muted)",
    },
  ".cm-activeLine": { backgroundColor: "transparent" },
  // Links (M3-005): the accent; missing ones dashed, ambiguous ones dotted.
  ".cm-link-note, .cm-link-missing, .cm-link-ambiguous, .cm-link-external": {
    color: "var(--color-accent-text)",
    textDecorationLine: "underline",
    textDecorationThickness: "var(--border-width)",
    textUnderlineOffset: "var(--space-1)",
  },
  // A link that leaves Liurium says so with an arrow (M3-012).
  ".cm-link-external::after": { content: '"\\2197"' },
  ".cm-link-missing": { textDecorationStyle: "dashed" },
  // #tags (M3-007): the accent, no fill.
  ".cm-tag": { color: "var(--color-accent-text)" },
  ".cm-link-ambiguous": { textDecorationStyle: "dotted" },
  // [[ suggestions
  ".cm-tooltip": {
    backgroundColor: "var(--color-surface-elevated)",
    color: "var(--color-text)",
    border: "var(--border-width) solid var(--color-border)",
    borderRadius: "var(--radius-md)",
  },
  ".cm-tooltip-autocomplete ul li": {
    padding: "var(--space-1) var(--space-2)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-accent-muted)",
    color: "var(--color-text)",
  },
  ".cm-completionDetail": {
    marginInlineStart: "var(--space-2)",
    color: "var(--color-text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    fontStyle: "normal",
  },
});

/** New links and tags from Rust; ranges already in editor positions. */
const setLinks = StateEffect.define<{
  links: readonly NoteLink[];
  tags: readonly NoteTag[];
}>();

const linkClass: Record<NoteLink["target"]["state"], string | null> = {
  note: "cm-link-note",
  missing: "cm-link-missing",
  ambiguous: "cm-link-ambiguous",
  external: "cm-link-external",
  other: null,
};

const FOLLOW_HINT = "Ctrl + click or Ctrl + Enter to follow";

/** An external link names its address, so the reader sees where it leads (M3-012). */
function linkTitle(link: NoteLink): string {
  return link.target.state === "external"
    ? `${link.target.address}\nCtrl + click or Ctrl + Enter to open`
    : FOLLOW_HINT;
}

const tagMark = Decoration.mark({ class: "cm-tag" });

function decorate(
  links: readonly NoteLink[],
  tags: readonly NoteTag[],
): DecorationSet {
  const marks: { from: number; to: number; mark: Decoration }[] = [];
  for (const link of links) {
    const className = linkClass[link.target.state];
    if (className !== null && link.to > link.from) {
      marks.push({
        from: link.from,
        to: link.to,
        mark: Decoration.mark({
          class: className,
          attributes: { title: linkTitle(link) },
        }),
      });
    }
  }
  for (const tag of tags) {
    if (tag.to > tag.from) {
      marks.push({ from: tag.from, to: tag.to, mark: tagMark });
    }
  }
  // The builder needs them in order.
  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, mark } of marks) {
    builder.add(from, to, mark);
  }
  return builder.finish();
}

/** The links Rust found, moved along with every edit until Rust sends new ones. */
const linksField = StateField.define<{
  links: readonly NoteLink[];
  marks: DecorationSet;
}>({
  create: () => ({ links: [], marks: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLinks)) {
        return {
          links: effect.value.links,
          marks: decorate(effect.value.links, effect.value.tags),
        };
      }
    }
    if (!transaction.docChanged) {
      return value;
    }
    const changes = transaction.changes;
    return {
      links: value.links.map((link) => ({
        ...link,
        from: changes.mapPos(link.from, 1),
        to: changes.mapPos(link.to, -1),
      })),
      marks: value.marks.map(changes),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.marks),
});

function linkAt(state: EditorState, pos: number): NoteLink | null {
  return (
    state
      .field(linksField)
      .links.find((link) => link.from <= pos && pos <= link.to) ?? null
  );
}

/** The front matter while the properties box shows it (M3-015). */
const setHidden = StateEffect.define<{ from: number; to: number } | null>();
/** A change the box asked for; only those may touch the hidden block. */
const fromBox = Annotation.define<boolean>();
const fromOutside = Annotation.define<boolean>();
const hiddenBlock = (from: number, to: number) =>
  Decoration.set(Decoration.replace({ block: true }).range(from, to));

const hiddenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHidden)) {
        return effect.value === null
          ? Decoration.none
          : hiddenBlock(effect.value.from, effect.value.to);
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

function hiddenRange(set: DecorationSet): { from: number; to: number } | null {
  const cursor = set.iter();
  return cursor.value === null ? null : { from: cursor.from, to: cursor.to };
}

/** While a block is hidden, typing, deleting, or selecting never reaches it: Backspace
 *  at the start of the text would otherwise take the whole block, and the cursor
 *  would vanish inside it. Undo and the box's own edits pass. */
function guardHidden(
  transaction: Transaction,
): TransactionSpec | readonly TransactionSpec[] {
  if (
    transaction.annotation(fromBox) === true ||
    transaction.isUserEvent("undo") ||
    transaction.isUserEvent("redo")
  ) {
    return transaction;
  }
  const before = hiddenRange(transaction.startState.field(hiddenField));
  let after = before;
  for (const effect of transaction.effects) {
    if (effect.is(setHidden)) {
      after = effect.value;
    }
  }
  if (after === null) {
    return transaction;
  }
  // Up to the last character of the block: typing right after it is fine.
  if (
    before !== null &&
    transaction.changes.touchesRange(before.from, before.to - 1) !== false
  ) {
    return {};
  }
  const end =
    after === before ? transaction.changes.mapPos(after.to, -1) : after.to;
  const selection = transaction.newSelection;
  if (selection.ranges.every((range) => range.from >= end)) {
    return transaction;
  }
  return [
    transaction,
    {
      selection: EditorSelection.create(
        selection.ranges.map((range) =>
          EditorSelection.range(
            Math.max(range.anchor, end),
            Math.max(range.head, end),
          ),
        ),
        selection.mainIndex,
      ),
      sequential: true,
    },
  ];
}

/** A note offered after `[[`. */
export interface Suggestion {
  /** Shown: the file name without its ending. */
  name: string;
  /** Shown beside it. */
  folder: string;
  /** Written inside `[[…]]`. */
  link: string;
}

/** Suggestions after `[[` up to the cursor, as long as no `]`, `|`, or `#` came. */
export function linkCompletions(suggestions: () => readonly Suggestion[]) {
  return (context: CompletionContext) => {
    const before = context.matchBefore(/\[\[[^[\]|#\r\n]*/);
    if (before === null) {
      return null;
    }
    const options: Completion[] = suggestions().map((suggestion) => ({
      label: suggestion.name,
      detail: suggestion.folder,
      apply: (view, _completion, from, to) => {
        const closed = view.state.sliceDoc(to, to + 2) === "]]";
        const insert = closed ? suggestion.link : `${suggestion.link}]]`;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length + (closed ? 2 : 0) },
        });
      },
    }));
    return { from: before.from + 2, options, validFor: /^[^[\]|#\r\n]*$/ };
  };
}

// Markdown marks stay visible but quiet; headings grow; code uses the code face.
const markdownLook = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontSize: "var(--font-size-xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  {
    tag: tags.heading2,
    fontSize: "var(--font-size-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    fontWeight: "var(--font-weight-semibold)",
  },
  { tag: tags.strong, fontWeight: "var(--font-weight-semibold)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.meta],
    color: "var(--color-text-secondary)",
  },
  { tag: tags.quote, color: "var(--color-text-secondary)" },
  {
    tag: [tags.link, tags.url],
    color: "var(--color-accent-text)",
  },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
]);

export interface NoteEditorOptions {
  text: string;
  /** The file's own line break; `null` keeps the text exactly (read-only notes). */
  lineBreak: "\r\n" | "\n" | null;
  readOnly: boolean;
  /** Called after every change the user makes. */
  onChange: (text: string) => void;
  /** Ctrl + S. */
  onSave: () => void;
  /** Read out as the editor's name. */
  label: string;
  /** Ctrl + click or Ctrl + Enter on a link (M3-005). */
  onFollow: (link: NoteLink) => void;
  /** Notes offered after `[[`. */
  suggestions: () => readonly Suggestion[];
}

export interface NoteEditor {
  /** The text with the file's line breaks: `sliceDoc`, never `doc.toString()`,
   *  which always joins with `\n` (ADR-0020). */
  text: () => string;
  setReadOnly: (readOnly: boolean) => void;
  /** Links and tags from Rust, ranges in editor positions. */
  setMarks: (links: readonly NoteLink[], tags: readonly NoteTag[]) => void;
  /** Hides the front matter while the properties box shows it; `null` shows it. */
  setHidden: (range: { from: number; to: number } | null) => void;
  /** Writes `insert` over an editor range, as if typed. */
  replace: (from: number, to: number, insert: string) => void;
  /** The same for an edit from the properties box, which may touch the hidden block. */
  replaceFromBox: (from: number, to: number, insert: string) => void;
  /** Takes over a change made outside Liurium (M3-008): only this span changes, so
   *  the cursor stays where it can. It is not a user's edit and is not saved. Undo
   *  starts over (owner decision Q5): undoing across it would bring old text back,
   *  and saving that would overwrite the outside change. */
  replaceFromOutside: (from: number, to: number, insert: string) => void;
  /** Puts the cursor at a position and scrolls it to the top. */
  goTo: (pos: number) => void;
  focus: () => void;
  destroy: () => void;
}

export function createNoteEditor(
  host: HTMLElement,
  options: NoteEditorOptions,
): NoteEditor {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const editable = new Compartment();
  const undo = new Compartment();
  const lineBreak = options.lineBreak;
  const extensions = [
    undo.of(history()),
    keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => {
          const link = linkAt(view.state, view.state.selection.main.head);
          if (link === null || link.target.state === "other") {
            return false;
          }
          options.onFollow(link);
          return true;
        },
      },
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          options.onSave();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown(),
    syntaxHighlighting(markdownLook),
    linksField,
    hiddenField,
    EditorState.transactionFilter.of(guardHidden),
    autocompletion({
      override: [linkCompletions(options.suggestions)],
      icons: false,
    }),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) {
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const link = pos === null ? null : linkAt(view.state, pos);
        if (link === null || link.target.state === "other") {
          return false;
        }
        event.preventDefault();
        options.onFollow(link);
        return true;
      },
    }),
    theme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": options.label,
      spellcheck: "false",
    }),
    editable.of(readOnlyExtensions(options.readOnly)),
    EditorView.updateListener.of((update) => {
      if (
        update.docChanged &&
        !update.transactions.some(
          (transaction) => transaction.annotation(fromOutside) === true,
        )
      ) {
        options.onChange(update.state.sliceDoc());
      }
    }),
  ];
  if (lineBreak !== null) {
    extensions.push(
      EditorState.lineSeparator.of(lineBreak),
      // Pasted or dropped text gets the file's line breaks, so a CRLF note never
      // gains a lone LF (CodeMirror splits only on the set separator).
      EditorView.clipboardInputFilter.of((text) =>
        text.replace(/\r\n|\r|\n/g, lineBreak),
      ),
    );
  }
  const view = new EditorView({
    state: EditorState.create({ doc: options.text, extensions }),
    parent: root,
    root,
  });
  return {
    text: () => view.state.sliceDoc(),
    setReadOnly: (readOnly) => {
      view.dispatch({
        effects: editable.reconfigure(readOnlyExtensions(readOnly)),
      });
    },
    setMarks: (links, tags) => {
      view.dispatch({ effects: setLinks.of({ links, tags }) });
    },
    setHidden: (range) => {
      view.dispatch({ effects: setHidden.of(range) });
    },
    replace: (from, to, insert) => {
      view.dispatch({ changes: { from, to, insert }, userEvent: "input" });
    },
    replaceFromBox: (from, to, insert) => {
      view.dispatch({
        changes: { from, to, insert },
        annotations: fromBox.of(true),
        userEvent: "input",
      });
    },
    replaceFromOutside: (from, to, insert) => {
      view.dispatch({
        changes: { from, to, insert },
        annotations: [fromBox.of(true), fromOutside.of(true)],
      });
      // Taking the history out and putting a new one in is how it is emptied.
      view.dispatch({ effects: undo.reconfigure([]) });
      view.dispatch({ effects: undo.reconfigure(history()) });
    },
    goTo: (pos) => {
      const at = Math.min(pos, view.state.doc.length);
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "start" }),
      });
      view.focus();
    },
    focus: () => {
      view.focus();
    },
    destroy: () => {
      view.destroy();
    },
  };
}

function readOnlyExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
