import {
  Annotation,
  type EditorSelection,
  type EditorState,
  Facet,
  StateEffect,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { NoteImage, NoteLink, NoteMath } from "../../lib/ipc/commands";

// What live preview's parts share (M3-017, M3-018).

export type LinksOf = (state: EditorState) => readonly NoteLink[];
export type ImagesOf = (state: EditorState) => readonly NoteImage[];
export type MathOf = (state: EditorState) => readonly NoteMath[];

export interface LiveActions {
  follow: (link: NoteLink) => void;
  save: () => void;
}

/** Where this editor keeps Rust's links. */
export const linksOf = Facet.define<LinksOf, LinksOf>({
  combine: (values) => values[0] ?? (() => []),
});

const NO_ACTIONS: LiveActions = {
  follow: () => {
    // Nothing is set up to follow a link, as in tests of the view alone.
  },
  save: () => {
    // Likewise.
  },
};

export const actionsOf = Facet.define<LiveActions, LiveActions>({
  combine: (values) => values[0] ?? NO_ACTIONS,
});

export const linksIn = (state: EditorState): readonly NoteLink[] =>
  state.facet(linksOf)(state);

/** Where this editor keeps Rust's images (M3-013). */
export const imagesOf = Facet.define<ImagesOf, ImagesOf>({
  combine: (values) => values[0] ?? (() => []),
});

export const imagesIn = (state: EditorState): readonly NoteImage[] =>
  state.facet(imagesOf)(state);

/** Where this editor keeps Rust's formulas (M3-010). */
export const mathOf = Facet.define<MathOf, MathOf>({
  combine: (values) => values[0] ?? (() => []),
});

export const mathIn = (state: EditorState): readonly NoteMath[] =>
  state.facet(mathOf)(state);

/** Whether the cursor or a selection touches this range: then its marks show. */
export function touched(
  selection: EditorSelection,
  from: number,
  to: number,
): boolean {
  return selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** The arrow keys go into a block from the line next to it: a block widget has no
 *  lines of its own, so they would move past it. */
export function enterBlock(
  view: EditorView,
  forward: boolean,
  blocks: readonly { from: number; to: number }[],
): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const moved = view.moveVertically(range, forward).head;
  const block = blocks.find((each) =>
    forward
      ? range.head < each.from && moved >= each.from
      : range.head > each.to && moved <= each.to,
  );
  if (block === undefined) {
    return false;
  }
  view.dispatch({
    selection: { anchor: forward ? block.from : block.to },
    scrollIntoView: true,
  });
  return true;
}

/** After a mouse drag: the decorations held still during it come up to date. */
export const dragEnded = StateEffect.define();

/** A change that may touch a table or a closed callout's text: from a table's own
 *  cells, the properties box, or the file changing outside. */
export const trustedEdit = Annotation.define<boolean>();

/** Where the body starts: the front matter is YAML, not Markdown (same rule as Rust). */
export function bodyStart(state: EditorState): number {
  const first = state.doc.line(1);
  if (first.text !== "---") {
    return 0;
  }
  for (let number = 2; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (line.text === "---" || line.text === "...") {
      return line.to;
    }
  }
  return 0;
}
