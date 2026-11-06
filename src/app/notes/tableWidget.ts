import { redo, undo } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import type { NoteLink } from "../../lib/ipc/commands";
import { actionsOf, linksIn, trustedEdit } from "./liveShared";
import {
  addColumn,
  addRow,
  type Align,
  cellSource,
  cellValue,
  parseTable,
  removeColumn,
  removeRow,
  setCell,
  type Table,
  type TextChange,
} from "./tableModel";

// A table in live preview (M3-018): a real <table> from DOM text, never HTML from the
// note. A cell becomes a text field while it is edited, and each change is one normal
// editor edit through `tableModel`, which touches only the affected bytes and refuses
// a result it cannot read back. Listeners read the table from the document when they
// run, so they stay right when the widget is reused for newer text.

const LINK_CLASS: Partial<Record<NoteLink["target"]["state"], string>> = {
  note: "cm-link-note",
  missing: "cm-link-missing",
  ambiguous: "cm-link-ambiguous",
  external: "cm-link-external",
};

/** A link's place inside the table's text. */
interface RelativeLink {
  from: number;
  to: number;
  link: NoteLink;
}

const INLINE_ELEMENT: Record<string, string> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "s",
  InlineCode: "code",
};
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

/** A cell's Markdown as DOM: marks left out, everything else as text. */
function appendInline(parent: Node, text: string): void {
  const tree = markdownLanguage.parser.parse(text);
  const walk = (
    target: Node,
    from: number,
    to: number,
    child: typeof tree.topNode.firstChild,
  ) => {
    let at = from;
    for (let node = child; node !== null; node = node.nextSibling) {
      if (node.from > at) {
        target.appendChild(document.createTextNode(text.slice(at, node.from)));
      }
      at = node.to;
      if (INLINE_MARKS.has(node.name)) {
        continue;
      }
      const tag = INLINE_ELEMENT[node.name] as string | undefined;
      if (tag !== undefined) {
        const element = document.createElement(tag);
        walk(element, node.from, node.to, node.firstChild);
        target.appendChild(element);
      } else if (node.name === "Escape") {
        target.appendChild(
          document.createTextNode(text.slice(node.from + 1, node.to)),
        );
      } else if (
        node.firstChild === null ||
        node.name === "Link" ||
        node.name === "Image"
      ) {
        target.appendChild(
          document.createTextNode(text.slice(node.from, node.to)),
        );
      } else {
        walk(target, node.from, node.to, node.firstChild);
      }
    }
    if (to > at) {
      target.appendChild(document.createTextNode(text.slice(at, to)));
    }
  };
  walk(parent, 0, text.length, tree.topNode.firstChild);
}

/** What a link shows: a wikilink its text, a Markdown link what is in its brackets. */
function linkText(source: string): string {
  if (source.startsWith("[[") && source.endsWith("]]")) {
    const inner = source.slice(2, -2);
    const pipe = inner.search(/\\?\|/);
    return pipe < 0
      ? inner
      : inner.slice(pipe + (inner[pipe] === "\\" ? 2 : 1));
  }
  if (source.startsWith("<") && source.endsWith(">")) {
    return source.slice(1, -1);
  }
  const markdown =
    /^\[(.*)\]\(.*\)$/.exec(source) ?? /^\[(.*)\]\[.*\]$/.exec(source);
  return markdown === null ? source : markdown[1];
}

function fillCell(
  cell: HTMLElement,
  text: string,
  from: number,
  links: readonly RelativeLink[],
): void {
  cell.replaceChildren();
  let at = 0;
  for (const { from: linkFrom, to, link } of links) {
    const start = linkFrom - from;
    const end = to - from;
    if (start < at || end > text.length) {
      continue;
    }
    appendInline(cell, text.slice(at, start));
    const shown = document.createElement("span");
    const className = LINK_CLASS[link.target.state];
    if (className === undefined) {
      shown.textContent = text.slice(start, end);
    } else {
      shown.className = className;
      shown.dataset.link = String(linkFrom);
      appendInline(shown, linkText(text.slice(start, end)));
      if (link.target.state === "external") {
        shown.title = link.target.address;
      }
    }
    cell.appendChild(shown);
    at = end;
  }
  appendInline(cell, text.slice(at));
}

const ALIGN_CLASS: Record<Exclude<Align, null>, string> = {
  left: "cm-align-left",
  center: "cm-align-center",
  right: "cm-align-right",
};

function cellOf(
  wrap: HTMLElement,
  row: number,
  column: number,
): HTMLElement | null {
  return wrap.querySelector(`[data-cell="${String(row)}:${String(column)}"]`);
}

/** The table around a position, as the document holds it now. */
function tableAt(
  state: EditorState,
  pos: number,
): { table: Table; source: string } | null {
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"]["parent"] = syntaxTree(
      state,
    ).resolveInner(pos, 1);
    node !== null;
    node = node.parent
  ) {
    if (node.name === "Table") {
      const source = state.doc.sliceString(node.from, node.to, "\n");
      const table = parseTable(source, node.from);
      return table === null ? null : { table, source };
    }
  }
  return null;
}

type Edit = (table: Table, source: string) => TextChange[] | null;

/** One normal edit through the model; `false` when the model refuses it. */
function apply(view: EditorView, pos: number, edit: Edit): boolean {
  const found = tableAt(view.state, pos);
  if (found === null || view.state.readOnly) {
    return false;
  }
  const changes = edit(found.table, found.source);
  if (changes === null) {
    return false;
  }
  if (changes.length > 0) {
    view.dispatch({
      changes,
      annotations: trustedEdit.of(true),
      userEvent: "input",
    });
  }
  return true;
}

function wrapAt(view: EditorView, pos: number): HTMLElement | null {
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>(
    ".cm-table-wrap",
  )) {
    if (view.posAtDOM(wrap) === pos) {
      return wrap;
    }
  }
  return null;
}

function currentCell(wrap: HTMLElement): { row: number; column: number } {
  return {
    row: Number(wrap.dataset.row ?? "0"),
    column: Number(wrap.dataset.column ?? "0"),
  };
}

/** Shows a cell's text again, formatted. */
function leaveCell(
  wrap: HTMLElement,
  view: EditorView,
  cell: HTMLElement,
): void {
  const pos = view.posAtDOM(wrap);
  const found = tableAt(view.state, pos);
  const [row, column] = (cell.dataset.cell ?? "0:0").split(":").map(Number);
  const data = found?.table.rows[row]?.cells[column];
  const text = data?.text ?? "";
  const links = linksIn(view.state)
    .filter(
      (link) =>
        data !== undefined && link.from >= data.from && link.to <= data.to,
    )
    .map((link) => ({ from: link.from, to: link.to, link }));
  fillCell(cell, text, data?.from ?? pos, links);
}

function commit(
  wrap: HTMLElement,
  view: EditorView,
  input: HTMLInputElement,
): void {
  const { row, column } = currentCell(wrap);
  const accepted = apply(view, view.posAtDOM(wrap), (table, source) =>
    setCell(table, source, row, column, input.value),
  );
  if (!accepted) {
    // The model could not keep the other cells as they are; the text stays.
    const found = tableAt(view.state, view.posAtDOM(wrap));
    input.value = cellValue(found?.table.rows[row]?.cells[column]?.text ?? "");
  }
}

/** Turns a cell into a text field and focuses it. */
export function enterCell(
  wrap: HTMLElement,
  view: EditorView,
  row: number,
  column: number,
  caret: "start" | "end" = "end",
): void {
  const cell = cellOf(wrap, row, column);
  if (cell === null || view.state.readOnly) {
    return;
  }
  wrap.dataset.row = String(row);
  wrap.dataset.column = String(column);
  const found = tableAt(view.state, view.posAtDOM(wrap));
  const input = document.createElement("input");
  input.className = "cm-cell-input";
  input.spellcheck = false;
  input.setAttribute(
    "aria-label",
    `${row === 0 ? "Header" : `Row ${String(row)}`}, column ${String(column + 1)}`,
  );
  input.value = cellValue(found?.table.rows[row]?.cells[column]?.text ?? "");
  cell.replaceChildren(input);
  input.focus();
  const at = caret === "start" ? 0 : input.value.length;
  input.setSelectionRange(at, at);
}

/** Makes a place to type after a table that ends the file: an empty line first, because
 *  Markdown reads a line right below a table as one more row. */
export function lineAfterTable(view: EditorView, to: number): void {
  const insert = view.state.lineBreak + view.state.lineBreak;
  view.focus();
  view.dispatch({
    changes: { from: to, insert },
    selection: { anchor: to + 2 },
    annotations: trustedEdit.of(true),
    userEvent: "input",
    scrollIntoView: true,
  });
}

/** Puts the cursor back in the text, just outside the table. Before a table that starts
 *  the file there is no place, so the cell keeps the focus. */
function leaveTable(
  view: EditorView,
  wrap: HTMLElement,
  side: "before" | "after",
  makeRoom = false,
): void {
  const pos = view.posAtDOM(wrap);
  const found = tableAt(view.state, pos);
  const to = found?.table.to ?? pos;
  const length = view.state.doc.length;
  if (side === "before" && pos === 0) {
    return;
  }
  if (side === "after" && to >= length) {
    if (makeRoom && !view.state.readOnly) {
      lineAfterTable(view, to);
    } else {
      view.focus();
    }
    return;
  }
  view.focus();
  view.dispatch({
    selection: { anchor: side === "before" ? pos - 1 : to + 1 },
    scrollIntoView: true,
  });
}

function handleCellKey(
  event: KeyboardEvent,
  wrap: HTMLElement,
  view: EditorView,
  input: HTMLInputElement,
): void {
  const found = tableAt(view.state, view.posAtDOM(wrap));
  if (found === null) {
    return;
  }
  const { row, column } = currentCell(wrap);
  const rows = found.table.rows.length;
  const columns = found.table.columns;
  const go = (
    toRow: number,
    toColumn: number,
    caret: "start" | "end" = "end",
  ) => {
    event.preventDefault();
    enterCell(wrap, view, toRow, toColumn, caret);
  };
  const control = event.ctrlKey || event.metaKey;
  if (control) {
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") {
      event.preventDefault();
      if (key === "y" || event.shiftKey) {
        redo(view);
      } else {
        undo(view);
      }
    } else if (key === "s") {
      event.preventDefault();
      view.state.facet(actionsOf).save();
    }
    return;
  }
  switch (event.key) {
    case "Tab":
      if (event.shiftKey) {
        if (column > 0) {
          go(row, column - 1);
        } else if (row > 0) {
          go(row - 1, columns - 1);
        } else {
          event.preventDefault();
          leaveTable(view, wrap, "before");
        }
      } else if (column + 1 < columns) {
        go(row, column + 1);
      } else if (row + 1 < rows) {
        go(row + 1, 0);
      } else {
        const tool = wrap.querySelector<HTMLElement>(".cm-table-tools button");
        if (tool !== null) {
          event.preventDefault();
          tool.focus();
        }
      }
      break;
    case "Enter": {
      if (row + 1 < rows) {
        go(row + 1, column);
      } else {
        event.preventDefault();
        const pos = view.posAtDOM(wrap);
        apply(view, pos, (table, source) =>
          addRow(table, source, row, view.state.lineBreak),
        );
        const now = wrapAt(view, pos);
        if (now !== null) {
          enterCell(now, view, row + 1, column);
        }
      }
      break;
    }
    case "Escape":
      event.preventDefault();
      leaveTable(view, wrap, "after");
      break;
    case "ArrowUp":
      if (row > 0) {
        go(row - 1, column);
      } else {
        event.preventDefault();
        leaveTable(view, wrap, "before");
      }
      break;
    case "ArrowDown":
      if (row + 1 < rows) {
        go(row + 1, column);
      } else {
        event.preventDefault();
        leaveTable(view, wrap, "after", true);
      }
      break;
    case "ArrowLeft":
      if (
        input.selectionStart === 0 &&
        input.selectionEnd === 0 &&
        column > 0
      ) {
        go(row, column - 1);
      }
      break;
    case "ArrowRight":
      if (
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length &&
        column + 1 < columns
      ) {
        go(row, column + 1, "start");
      }
      break;
    default:
      break;
  }
}

function runTool(wrap: HTMLElement, view: EditorView, tool: string): void {
  const pos = view.posAtDOM(wrap);
  const { row, column } = currentCell(wrap);
  const found = tableAt(view.state, pos);
  if (found === null) {
    return;
  }
  const rows = found.table.rows.length;
  let next = { row, column };
  const accepted = apply(view, pos, (table, source) => {
    switch (tool) {
      case "addRow":
        next = { row: row + 1, column };
        return addRow(table, source, row, view.state.lineBreak);
      case "addColumn":
        next = { row, column: column + 1 };
        return addColumn(table, source, column + 1);
      case "removeRow":
        next = { row: Math.min(row, rows - 2), column };
        return removeRow(table, source, row);
      default:
        next = { row, column: Math.max(0, column - 1) };
        return removeColumn(table, source, column);
    }
  });
  const now = wrapAt(view, pos);
  if (accepted && now !== null) {
    enterCell(now, view, next.row, next.column);
  }
}

const TOOLS: readonly (readonly [string, string])[] = [
  ["addRow", "Add row"],
  ["addColumn", "Add column"],
  ["removeRow", "Delete row"],
  ["removeColumn", "Delete column"],
];

function listen(wrap: HTMLElement, view: EditorView): void {
  wrap.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const tool = target.closest<HTMLElement>("[data-tool]");
    if (tool?.dataset.tool !== undefined) {
      runTool(wrap, view, tool.dataset.tool);
      return;
    }
    const shown = target.closest<HTMLElement>("[data-link]");
    if (shown?.dataset.link !== undefined) {
      const from = view.posAtDOM(wrap) + Number(shown.dataset.link);
      const link = linksIn(view.state).find((each) => each.from === from);
      if (link !== undefined) {
        view.state.facet(actionsOf).follow(link);
      }
      return;
    }
    const cell = target.closest<HTMLElement>("[data-cell]");
    if (
      cell?.dataset.cell !== undefined &&
      !(target instanceof HTMLInputElement)
    ) {
      const [row, column] = cell.dataset.cell.split(":").map(Number);
      enterCell(wrap, view, row, column);
    }
  });
  // A press on the toolbar keeps the cell it acts on.
  wrap.addEventListener("mousedown", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-tool]") !== null
    ) {
      event.preventDefault();
    }
  });
  wrap.addEventListener("input", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.classList.contains("cm-cell-input") &&
      !event.isComposing
    ) {
      commit(wrap, view, event.target);
    }
  });
  wrap.addEventListener("compositionend", (event) => {
    if (event.target instanceof HTMLInputElement) {
      commit(wrap, view, event.target);
    }
  });
  wrap.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      handleCellKey(event, wrap, view, target);
    } else if (
      target instanceof HTMLElement &&
      target.dataset.tool !== undefined
    ) {
      if (event.key === "Escape") {
        event.preventDefault();
        leaveTable(view, wrap, "after");
      } else if (event.key === "Tab") {
        const tools = wrap.querySelectorAll("[data-tool]");
        if (event.shiftKey && target === tools[0]) {
          event.preventDefault();
          const { row, column } = currentCell(wrap);
          enterCell(wrap, view, row, column);
        } else if (!event.shiftKey && target === tools[tools.length - 1]) {
          event.preventDefault();
          leaveTable(view, wrap, "after");
        }
      }
    }
  });
  wrap.addEventListener("focusout", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      const cell = target.closest<HTMLElement>("[data-cell]");
      if (cell !== null) {
        leaveCell(wrap, view, cell);
      }
    }
  });
}

export class TableWidget extends WidgetType {
  private readonly table: Table | null;

  constructor(
    private readonly source: string,
    private readonly readOnly: boolean,
    /** Places inside the table's text. */
    private readonly links: readonly RelativeLink[],
  ) {
    super();
    this.table = parseTable(source);
  }

  private get linksKey(): string {
    return this.links
      .map(
        ({ from, to, link }) =>
          `${String(from)}-${String(to)}-${JSON.stringify(link.target)}`,
      )
      .join(",");
  }

  override eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.readOnly === this.readOnly &&
      other.linksKey === this.linksKey
    );
  }

  private linksIn(from: number, to: number): RelativeLink[] {
    return this.links.filter((link) => link.from >= from && link.to <= to);
  }

  private build(wrap: HTMLElement): void {
    const table = this.table;
    if (table === null) {
      return;
    }
    const element = document.createElement("table");
    element.className = "cm-table";
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    table.rows.forEach((row, rowIndex) => {
      const line = document.createElement("tr");
      for (let column = 0; column < table.columns; column += 1) {
        const cell = document.createElement(rowIndex === 0 ? "th" : "td");
        cell.dataset.cell = `${String(rowIndex)}:${String(column)}`;
        const align = table.aligns[column];
        if (align !== null) {
          cell.className = ALIGN_CLASS[align];
        }
        const data = row.cells[column] as
          (typeof row.cells)[number] | undefined;
        if (data !== undefined) {
          fillCell(
            cell,
            data.text,
            data.from,
            this.linksIn(data.from, data.to),
          );
        }
        line.appendChild(cell);
      }
      (rowIndex === 0 ? head : body).appendChild(line);
    });
    element.append(head, body);
    wrap.replaceChildren(element);
    if (!this.readOnly) {
      const tools = document.createElement("div");
      tools.className = "cm-table-tools";
      for (const [tool, label] of TOOLS) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.tool = tool;
        button.textContent = label;
        button.className = "cm-table-tool";
        tools.appendChild(button);
      }
      wrap.appendChild(tools);
    }
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    this.build(wrap);
    listen(wrap, view);
    return wrap;
  }

  /** Reuses the DOM for newer text, so the cell being typed in keeps its focus. */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const table = this.table;
    if (table === null) {
      return false;
    }
    const active = dom.querySelector<HTMLInputElement>(".cm-cell-input");
    const shown = dom.querySelectorAll("[data-cell]").length;
    if (shown !== table.rows.length * table.columns) {
      const hadFocus = active !== null;
      const { row, column } = currentCell(dom);
      this.build(dom);
      if (hadFocus) {
        enterCell(
          dom,
          view,
          Math.min(row, table.rows.length - 1),
          Math.min(column, table.columns - 1),
        );
      }
      return true;
    }
    table.rows.forEach((row, rowIndex) => {
      for (let column = 0; column < table.columns; column += 1) {
        const cell = cellOf(dom, rowIndex, column);
        const data = row.cells[column] as
          (typeof row.cells)[number] | undefined;
        if (cell === null) {
          continue;
        }
        const input = active !== null && cell.contains(active) ? active : null;
        if (input !== null) {
          // Undo changed it, or typing did and then it already matches.
          if (cellSource(input.value) !== (data?.text ?? "")) {
            input.value = cellValue(data?.text ?? "");
          }
        } else if (data !== undefined) {
          fillCell(
            cell,
            data.text,
            data.from,
            this.linksIn(data.from, data.to),
          );
        } else {
          cell.replaceChildren();
        }
      }
    });
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Moves into a table from the line next to it. */
export function focusTable(
  view: EditorView,
  pos: number,
  where: "first" | "last",
): boolean {
  const wrap = wrapAt(view, pos);
  const found = tableAt(view.state, pos);
  if (wrap === null || found === null || view.state.readOnly) {
    return false;
  }
  enterCell(wrap, view, where === "first" ? 0 : found.table.rows.length - 1, 0);
  return true;
}
