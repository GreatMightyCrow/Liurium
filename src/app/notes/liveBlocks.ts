import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type Range,
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
import { definersBefore, definersIn } from "./liveMath";
import {
  bodyStart,
  imagesIn,
  linksIn,
  mathIn,
  settledIn,
  trustedEdit,
} from "./liveShared";
import { parseTable } from "./tableModel";
import { focusTable, lineAfterTable, TableWidget } from "./tableWidget";

// What live preview shows instead of whole lines (M3-018): tables and the bodies of
// closed callouts. Block decorations must come from a state field. The text under them
// stays in the document; a filter keeps the cursor out and plain Backspace or Delete
// from taking the whole block, because CodeMirror deletes such a range as one.

/** Larger tables stay as text. */
const MAX_TABLE_ROWS = 500;

export type CalloutLook = "plain" | "good" | "careful" | "bad";

const LOOKS: Record<string, CalloutLook> = {
  tip: "good",
  hint: "good",
  important: "good",
  success: "good",
  check: "good",
  done: "good",
  warning: "careful",
  caution: "careful",
  attention: "careful",
  failure: "bad",
  fail: "bad",
  missing: "bad",
  danger: "bad",
  error: "bad",
  bug: "bad",
};

export interface Callout {
  /** Without the brackets, as written. */
  kind: string;
  look: CalloutLook;
  fold: "" | "+" | "-";
  /** `[!kind]-` inside the line. */
  markerFrom: number;
  markerTo: number;
  /** Text after the marker. */
  title: string;
}

/** A quote's first line as a callout (`> [!note] Title`), or `null`. */
export function calloutOf(line: string): Callout | null {
  const found = /^(\s*>\s*)(\[!([A-Za-z][\w-]*)\]([+-]?))[ \t]*(.*)$/.exec(
    line,
  );
  if (found === null) {
    return null;
  }
  const [, before, marker, kind, fold, title] = found;
  return {
    kind,
    look: LOOKS[kind.toLowerCase()] ?? "plain",
    fold: fold as Callout["fold"],
    markerFrom: before.length,
    markerTo: before.length + marker.length,
    title,
  };
}

/** A foldable callout: its title line and the lines under it. */
interface Foldable {
  line: number;
  bodyFrom: number;
  bodyTo: number;
  open: boolean;
}

interface Blocks {
  tables: readonly { from: number; to: number }[];
  folds: readonly Foldable[];
  /** Callouts opened or closed by hand, by their title line; not written to the file. */
  chosen: ReadonlyMap<number, boolean>;
  marks: DecorationSet;
}

const toggleFold = StateEffect.define<number>();

function build(
  state: EditorState,
  chosen: ReadonlyMap<number, boolean>,
): Blocks {
  const ranges: Range<Decoration>[] = [];
  const tables: { from: number; to: number }[] = [];
  const folds: Foldable[] = [];
  const body = bodyStart(state);
  const links = linksIn(state);
  const images = imagesIn(state);
  const settled = settledIn(state);
  const math = mathIn(state);
  const definers = definersIn(math);
  for (
    let node = syntaxTree(state).topNode.firstChild;
    node !== null;
    node = node.nextSibling
  ) {
    if (node.to <= body) {
      continue;
    }
    if (node.name === "Table") {
      const { from, to } = node;
      const whole =
        state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
      const source = state.doc.sliceString(from, to, "\n");
      const table = whole ? parseTable(source) : null;
      if (
        table !== null &&
        table.rows.length <= MAX_TABLE_ROWS &&
        // Both parsers must see the same rows, or it stays as text.
        node.getChildren("TableRow").length === table.rows.length - 1
      ) {
        const inside = links
          .filter((link) => link.from >= from && link.to <= to)
          .map((link) => ({
            from: link.from - from,
            to: link.to - from,
            link,
          }));
        const pictures = images
          .filter((image) => image.from >= from && image.to <= to)
          .map((image) => ({
            from: image.from - from,
            to: image.to - from,
            image,
          }));
        const formulas = math
          .filter((formula) => formula.from >= from && formula.to <= to)
          .map((formula) => ({
            from: formula.from - from,
            to: formula.to - from,
            math: formula,
            definers: definersBefore(definers, formula.from),
          }));
        tables.push({ from, to });
        ranges.push(
          Decoration.replace({
            widget: new TableWidget(
              source,
              state.readOnly,
              inside,
              pictures,
              formulas,
              settled,
            ),
            block: true,
          }).range(from, to),
        );
      }
    } else if (node.name === "Blockquote") {
      const first = state.doc.lineAt(node.from);
      const callout = calloutOf(first.text);
      const last = state.doc.lineAt(node.to);
      if (
        callout !== null &&
        callout.fold !== "" &&
        last.number > first.number
      ) {
        const open = chosen.get(first.from) ?? callout.fold === "+";
        const bodyFrom = state.doc.line(first.number + 1).from;
        folds.push({ line: first.from, bodyFrom, bodyTo: last.to, open });
        if (!open) {
          ranges.push(
            Decoration.replace({ block: true }).range(bodyFrom, last.to),
          );
        }
      }
    }
  }
  return { tables, folds, chosen, marks: Decoration.set(ranges, true) };
}

export const blocksField = StateField.define<Blocks>({
  create: (state) => build(state, new Map()),
  update(value, transaction) {
    let chosen = value.chosen;
    if (transaction.docChanged && chosen.size > 0) {
      chosen = new Map(
        [...chosen].map(([pos, open]) => [
          transaction.changes.mapPos(pos),
          open,
        ]),
      );
    }
    let toggled = false;
    for (const effect of transaction.effects) {
      if (effect.is(toggleFold)) {
        const fold = value.folds.find((each) => each.line === effect.value);
        if (fold !== undefined) {
          chosen = new Map(chosen).set(fold.line, !fold.open);
          toggled = true;
        }
      }
    }
    const { state, startState } = transaction;
    if (
      !toggled &&
      !transaction.docChanged &&
      syntaxTree(state) === syntaxTree(startState) &&
      linksIn(state) === linksIn(startState) &&
      imagesIn(state) === imagesIn(startState) &&
      settledIn(state) === settledIn(startState) &&
      mathIn(state) === mathIn(startState) &&
      state.readOnly === startState.readOnly
    ) {
      return value;
    }
    return build(state, chosen);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.marks),
    EditorView.atomicRanges.of((view) => view.state.field(field).marks),
  ],
});

/** Whether a callout with this title line is open; `null` when it cannot fold. */
export function calloutOpen(state: EditorState, line: number): boolean | null {
  const fold = state
    .field(blocksField, false)
    ?.folds.find((each) => each.line === line);
  return fold === undefined ? null : fold.open;
}

export function toggleCallout(view: EditorView, line: number): void {
  view.dispatch({ effects: toggleFold.of(line) });
}

/** Ctrl + Enter on a foldable callout's title line. */
export function toggleCalloutAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (calloutOpen(view.state, line.from) === null) {
    return false;
  }
  toggleCallout(view, line.from);
  return true;
}

function blockRanges(blocks: Blocks): { from: number; to: number }[] {
  return [
    ...blocks.tables,
    ...blocks.folds
      .filter((fold) => !fold.open)
      .map((fold) => ({ from: fold.bodyFrom, to: fold.bodyTo })),
  ];
}

/** A plain Backspace or Delete must not take a block, or pull a line up under a
 *  table: Markdown reads a line right below a table as one more row. */
function harmsBlock(
  transaction: Transaction,
  ranges: readonly { from: number; to: number }[],
  tables: readonly { from: number; to: number }[],
): boolean {
  const changed: { from: number; to: number }[] = [];
  transaction.changes.iterChangedRanges((from, to) => {
    changed.push({ from, to });
  });
  const after = transaction.newDoc;
  return (
    changed.some(({ from, to }) =>
      ranges.some((range) => from < range.to && to > range.from),
    ) ||
    tables.some((table) => {
      const end = transaction.changes.mapPos(table.to, -1);
      if (end >= after.length) {
        return false;
      }
      return after.lineAt(end + 1).text !== "";
    })
  );
}

function guardBlocks(
  transaction: Transaction,
): TransactionSpec | readonly TransactionSpec[] {
  const start = transaction.startState;
  const blocks = start.field(blocksField, false);
  if (blocks === undefined) {
    return transaction;
  }
  const ranges = blockRanges(blocks);
  if (ranges.length === 0) {
    return transaction;
  }
  const selection = start.selection.main;
  const free =
    transaction.annotation(trustedEdit) === true ||
    transaction.isUserEvent("undo") ||
    transaction.isUserEvent("redo");
  if (
    !free &&
    transaction.docChanged &&
    selection.empty &&
    transaction.isUserEvent("delete") &&
    harmsBlock(transaction, ranges, blocks.tables)
  ) {
    return {};
  }
  // The cursor stays out, also after undo or a jump to a place inside.
  const mapped = ranges.map((range) => ({
    from: transaction.changes.mapPos(range.from, 1),
    to: transaction.changes.mapPos(range.to, -1),
  }));
  const outside = (pos: number) =>
    mapped.find((range) => pos > range.from && pos < range.to)?.to ?? pos;
  const next = transaction.newSelection;
  if (
    next.ranges.every(
      (range) =>
        outside(range.anchor) === range.anchor &&
        outside(range.head) === range.head,
    )
  ) {
    return transaction;
  }
  return [
    transaction,
    {
      selection: EditorSelection.create(
        next.ranges.map((range) =>
          EditorSelection.range(outside(range.anchor), outside(range.head)),
        ),
        next.mainIndex,
      ),
      sequential: true,
    },
  ];
}

/** The arrow keys go into a table from the line next to it, without a mouse. */
function enterTable(view: EditorView, forward: boolean): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const moved = view.moveVertically(range, forward).head;
  const table = view.state
    .field(blocksField)
    .tables.find((each) =>
      forward
        ? range.head <= each.from && moved >= each.from
        : range.head >= each.to && moved <= each.to,
    );
  return (
    table !== undefined &&
    focusTable(view, table.from, forward ? "first" : "last")
  );
}

/** After a table that ends the file there is nowhere for the cursor; a click below it
 *  makes a place, with an empty line so the text is no table row. */
function clickBelowTable(event: MouseEvent, view: EditorView): boolean {
  const { doc } = view.state;
  const last = view.state
    .field(blocksField)
    .tables.find((table) => table.to === doc.length);
  if (
    last === undefined ||
    event.button !== 0 ||
    view.state.readOnly ||
    !(event.target instanceof Element) ||
    event.target.closest(".cm-table-wrap") !== null ||
    view.posAtCoords({ x: event.clientX, y: event.clientY }) !== doc.length
  ) {
    return false;
  }
  event.preventDefault();
  lineAfterTable(view, last.to);
  return true;
}

export function liveBlocks(): Extension {
  return [
    EditorView.domEventHandlers({ mousedown: clickBelowTable }),
    blocksField,
    EditorState.transactionFilter.of(guardBlocks),
    Prec.high(
      keymap.of([
        {
          key: "ArrowDown",
          run: (view) => enterTable(view, true),
        },
        {
          key: "ArrowUp",
          run: (view) => enterTable(view, false),
        },
      ]),
    ),
  ];
}
