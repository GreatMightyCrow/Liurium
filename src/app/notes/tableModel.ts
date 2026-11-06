// A Markdown table as text (M3-018): what its cells are, and pure edits that touch only
// the affected bytes. Nothing here knows the editor. Positions count a line break as
// one, as CodeMirror does, so the text is read with "\n" between its lines.

export type Align = "left" | "center" | "right" | null;

export interface TableCell {
  /** The cell's text without its padding; an empty cell has `from === to`. */
  from: number;
  to: number;
  text: string;
}

/** A piece between two pipes, padding included. */
interface Segment {
  from: number;
  to: number;
}

export interface TableRow {
  from: number;
  to: number;
  cells: TableCell[];
  segments: Segment[];
  /** The line ends with a pipe. */
  closed: boolean;
}

export interface Table {
  from: number;
  to: number;
  aligns: Align[];
  /** Header first, without the delimiter row. */
  rows: TableRow[];
  delimiter: TableRow;
  columns: number;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

function at<T>(list: readonly T[], index: number): T | undefined {
  return index >= 0 && index < list.length ? list[index] : undefined;
}

function parseRow(line: string, offset: number): TableRow {
  const segments: Segment[] = [];
  let start = 0;
  let first = true;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "|") {
      // A pipe opening the line starts no cell.
      if (!(first && line.slice(0, at).trim() === "")) {
        segments.push({ from: start, to: at });
      }
      first = false;
      start = at + 1;
    }
  }
  const closed = line.slice(start).trim() === "" && !first;
  if (!closed) {
    segments.push({ from: start, to: line.length });
  }
  const cells = segments.map(({ from, to }) => {
    const raw = line.slice(from, to);
    const text = raw.trim();
    if (text === "") {
      // Where a typed value goes: after one space of padding, if there is one.
      const at = from + Math.min(1, raw.length);
      return { from: offset + at, to: offset + at, text: "" };
    }
    const lead = raw.length - raw.trimStart().length;
    return {
      from: offset + from + lead,
      to: offset + from + lead + text.length,
      text,
    };
  });
  return {
    from: offset,
    to: offset + line.length,
    cells,
    segments: segments.map(({ from, to }) => ({
      from: offset + from,
      to: offset + to,
    })),
    closed,
  };
}

function alignOf(cell: string): Align | undefined {
  const text = cell.trim();
  if (!/^:?-+:?$/.test(text)) {
    return undefined;
  }
  if (text.startsWith(":") && text.endsWith(":")) {
    return "center";
  }
  if (text.endsWith(":")) {
    return "right";
  }
  return text.startsWith(":") ? "left" : null;
}

/** The table in `source`, which holds only its lines; `null` if it is not one. */
export function parseTable(source: string, offset = 0): Table | null {
  const lines = source.split("\n");
  if (lines.length < 2) {
    return null;
  }
  let at = offset;
  const parsed = lines.map((line) => {
    const row = parseRow(line, at);
    at += line.length + 1;
    return row;
  });
  const [header, delimiter, ...body] = parsed;
  const aligns = delimiter.cells.map((cell) => alignOf(cell.text));
  if (
    aligns.length === 0 ||
    aligns.includes(undefined) ||
    header.cells.length !== aligns.length
  ) {
    return null;
  }
  return {
    from: offset,
    to: offset + source.length,
    aligns: aligns.map((align) => align ?? null),
    rows: [header, ...body],
    delimiter,
    columns: aligns.length,
  };
}

/** What a typed value becomes in the file: one line, its pipes escaped, no padding. */
export function cellSource(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/\\?\|/g, "\\|");
}

/** What a text field shows for a cell: its text, with `\|` as the `|` it means. */
export function cellValue(text: string): string {
  return text.replace(/\\\|/g, "|");
}

function applied(
  source: string,
  offset: number,
  changes: readonly TextChange[],
) {
  let out = source;
  for (const { from, to, insert } of [...changes].sort(
    (a, b) => b.from - a.from,
  )) {
    out = out.slice(0, from - offset) + insert + out.slice(to - offset);
  }
  return out;
}

function matrix(table: Table): string[][] {
  return table.rows.map((row) => row.cells.map((cell) => cell.text));
}

/** Reads the result again: anything but exactly the expected cells refuses the edit. */
function checked(
  table: Table,
  source: string,
  changes: readonly TextChange[],
  expected: string[][],
): TextChange[] | null {
  const after = parseTable(applied(source, table.from, changes), table.from);
  if (after === null) {
    return null;
  }
  const found = matrix(after);
  const same =
    found.length === expected.length &&
    found.every(
      (row, index) =>
        row.length === expected[index].length &&
        row.every((cell, column) => cell === expected[index][column]),
    );
  return same ? [...changes] : null;
}

/** Writes one cell. A row with too few cells gains the missing ones. */
export function setCell(
  table: Table,
  source: string,
  row: number,
  column: number,
  value: string,
): TextChange[] | null {
  const target = at(table.rows, row);
  if (target === undefined || column >= table.columns) {
    return null;
  }
  const text = cellSource(value);
  const expected = matrix(table);
  while (expected[row].length <= column) {
    expected[row].push("");
  }
  expected[row][column] = text;
  const cell = at(target.cells, column);
  if (cell !== undefined) {
    if (cell.text === text) {
      return [];
    }
    return checked(
      table,
      source,
      [{ from: cell.from, to: cell.to, insert: text }],
      expected,
    );
  }
  const missing = column - target.cells.length;
  const blanks = "   |".repeat(missing);
  const insert = target.closed ? `${blanks} ${text} |` : ` |${blanks} ${text}`;
  return checked(
    table,
    source,
    [{ from: target.to, to: target.to, insert }],
    expected,
  );
}

function emptyRow(columns: number): string {
  return `|${"   |".repeat(columns)}`;
}

/** A new empty row after `row`; the header counts as row 0. */
export function addRow(
  table: Table,
  source: string,
  row: number,
  lineBreak: string,
): TextChange[] | null {
  const after = row === 0 ? table.delimiter : at(table.rows, row);
  if (after === undefined) {
    return null;
  }
  const expected = matrix(table);
  expected.splice(row + 1, 0, new Array<string>(table.columns).fill(""));
  // `checked` reads with "\n"; the editor gets the file's own line break.
  const result = checked(
    table,
    source,
    [{ from: after.to, to: after.to, insert: `\n${emptyRow(table.columns)}` }],
    expected,
  );
  return (
    result?.map((change) => ({
      ...change,
      insert: change.insert.replace("\n", lineBreak),
    })) ?? null
  );
}

/** Takes a row out; the header stays. */
export function removeRow(
  table: Table,
  source: string,
  row: number,
): TextChange[] | null {
  if (row === 0) {
    return null;
  }
  const target = at(table.rows, row);
  if (target === undefined) {
    return null;
  }
  const expected = matrix(table);
  expected.splice(row, 1);
  // With the line break before it, so the table's end stays at the line's end.
  return checked(
    table,
    source,
    [{ from: target.from - 1, to: target.to, insert: "" }],
    expected,
  );
}

function columnAdded(row: TableRow, column: number, blank: string): TextChange {
  const next = at(row.segments, column);
  if (next !== undefined) {
    return { from: next.from, to: next.from, insert: `${blank}|` };
  }
  return row.closed
    ? { from: row.to, to: row.to, insert: `${blank}|` }
    : // An empty last cell needs a closing pipe, or it would be no cell.
      { from: row.to, to: row.to, insert: `|${blank}|` };
}

/** A new empty column before `column`; `table.columns` adds one at the end. */
export function addColumn(
  table: Table,
  source: string,
  column: number,
): TextChange[] | null {
  if (column > table.columns) {
    return null;
  }
  const expected = matrix(table).map((row) => {
    const copy = [...row];
    if (column <= copy.length) {
      copy.splice(column, 0, "");
    }
    return copy;
  });
  const changes = table.rows.flatMap((row) =>
    column > row.segments.length ? [] : [columnAdded(row, column, "   ")],
  );
  changes.push(columnAdded(table.delimiter, column, " --- "));
  return checked(table, source, changes, expected);
}

function columnRemoved(row: TableRow, column: number): TextChange | null {
  const segment = at(row.segments, column);
  if (segment === undefined) {
    return null;
  }
  const next = at(row.segments, column + 1);
  if (next !== undefined) {
    return { from: segment.from, to: next.from, insert: "" };
  }
  // The last one: with the pipe before it, so a closing pipe stays.
  return { from: segment.from - 1, to: segment.to, insert: "" };
}

/** Takes a column out; the last one stays. */
export function removeColumn(
  table: Table,
  source: string,
  column: number,
): TextChange[] | null {
  if (table.columns < 2 || column >= table.columns) {
    return null;
  }
  const expected = matrix(table).map((row) =>
    row.filter((_, index) => index !== column),
  );
  const changes = [...table.rows, table.delimiter].flatMap((row) => {
    const change = columnRemoved(row, column);
    return change === null ? [] : [change];
  });
  return checked(table, source, changes, expected);
}
