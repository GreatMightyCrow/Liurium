import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// The note editor (ADR-0020): CodeMirror as the engine, everything visible from
// Liurium's tokens. It lives in a shadow root: there CodeMirror's styles become
// constructed style sheets, which the strict CSP allows; in the page itself its
// <style> elements would be blocked. Tokens are CSS custom properties, which
// reach into the shadow root; CSS Modules do not, so the look is set here.

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-text)",
    backgroundColor: "var(--color-canvas)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--font-size-md)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
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
});

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
}

export interface NoteEditor {
  /** The text with the file's line breaks: `sliceDoc`, never `doc.toString()`,
   *  which always joins with `\n` (ADR-0020). */
  text: () => string;
  setReadOnly: (readOnly: boolean) => void;
  focus: () => void;
  destroy: () => void;
}

export function createNoteEditor(
  host: HTMLElement,
  options: NoteEditorOptions,
): NoteEditor {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const editable = new Compartment();
  const lineBreak = options.lineBreak;
  const extensions = [
    history(),
    keymap.of([
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
    theme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": options.label,
      spellcheck: "false",
    }),
    editable.of(readOnlyExtensions(options.readOnly)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
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
