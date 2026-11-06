import { Annotation, type EditorState, Facet } from "@codemirror/state";
import type { NoteImage, NoteLink } from "../../lib/ipc/commands";

// What live preview's parts share (M3-017, M3-018).

export type LinksOf = (state: EditorState) => readonly NoteLink[];
export type ImagesOf = (state: EditorState) => readonly NoteImage[];

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
