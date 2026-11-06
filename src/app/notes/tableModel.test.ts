import { describe, expect, test } from "vitest";
import {
  addColumn,
  addRow,
  cellSource,
  cellValue,
  parseTable,
  removeColumn,
  removeRow,
  setCell,
  type Table,
  type TextChange,
} from "./tableModel";

const SOURCE = "| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |";

function table(source = SOURCE): Table {
  const parsed = parseTable(source);
  if (parsed === null) {
    throw new Error(`not a table: ${source}`);
  }
  return parsed;
}

function apply(source: string, changes: readonly TextChange[] | null): string {
  if (changes === null) {
    throw new Error("refused");
  }
  let out = source;
  for (const { from, to, insert } of [...changes].sort(
    (a, b) => b.from - a.from,
  )) {
    out = out.slice(0, from) + insert + out.slice(to);
  }
  return out;
}

function texts(source: string): string[][] {
  return table(source).rows.map((row) => row.cells.map((cell) => cell.text));
}

describe("reading", () => {
  test("cells, aligns, and places", () => {
    const parsed = table(
      "| a | b | c | d |\n|---|:--|--:|:-:|\n| 1 |  | 3 | 4 |",
    );
    expect(parsed.columns).toBe(4);
    expect(parsed.aligns).toEqual([null, "left", "right", "center"]);
    expect(parsed.rows[1].cells.map((cell) => cell.text)).toEqual([
      "1",
      "",
      "3",
      "4",
    ]);
    const cell = parsed.rows[0].cells[1];
    expect(cell.text).toBe("b");
    expect(SOURCE.slice(cell.from, cell.to)).toBe("b");
  });

  test("without outer pipes, and with an offset", () => {
    const parsed = parseTable("a | b\n--- | ---\n1 | 2", 100);
    expect(parsed?.columns).toBe(2);
    expect(parsed?.rows[1].cells[1]).toMatchObject({
      from: 100 + "a | b\n--- | ---\n1 | ".length,
      text: "2",
    });
  });

  test("an escaped pipe stays in its cell", () => {
    expect(texts("| a\\|b | c |\n|---|---|")).toEqual([["a\\|b", "c"]]);
  });

  test("what is no table", () => {
    for (const source of [
      "| a |",
      "| a | b |\n| c | d |",
      "| a | b |\n|---|",
      "| a |\n|---|---|",
      "",
      "\n",
    ]) {
      expect(parseTable(source), source).toBeNull();
    }
  });

  test("a row with too few or too many cells is kept as it is", () => {
    expect(texts("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")).toEqual([
      ["a", "b"],
      ["1"],
      ["1", "2", "3"],
    ]);
  });
});

describe("a cell", () => {
  test("only that cell's bytes change, padding and other rows stay", () => {
    const source = "|  a   |b|\n|---|---|\n|   1 | 2   |";
    const result = apply(source, setCell(table(source), source, 1, 0, "neu"));
    expect(result).toBe("|  a   |b|\n|---|---|\n|   neu | 2   |");
  });

  test("an empty cell takes the value after its padding", () => {
    const source = "| a | b |\n|---|---|\n|   |  |";
    expect(apply(source, setCell(table(source), source, 1, 0, "x"))).toBe(
      "| a | b |\n|---|---|\n| x  |  |",
    );
    expect(apply(source, setCell(table(source), source, 1, 1, "y"))).toBe(
      "| a | b |\n|---|---|\n|   | y |",
    );
  });

  test("the same value changes nothing", () => {
    expect(setCell(table(), SOURCE, 1, 0, " 1 ")).toEqual([]);
  });

  test("pipes and line breaks cannot break the table", () => {
    const result = apply(SOURCE, setCell(table(), SOURCE, 1, 0, "x|y\nz"));
    expect(result).toBe("| a | b |\n|---|:-:|\n| x\\|y z | 2 |\n| 3 | 4 |");
    expect(texts(result)[1]).toEqual(["x\\|y z", "2"]);
  });

  test("a row with too few cells gains what is missing", () => {
    const source = "| a | b | c |\n|---|---|---|\n| 1 |";
    expect(apply(source, setCell(table(source), source, 1, 2, "x"))).toBe(
      "| a | b | c |\n|---|---|---|\n| 1 |   | x |",
    );
    const open = "a | b\n---|---\n1";
    expect(apply(open, setCell(table(open), open, 1, 1, "x"))).toBe(
      "a | b\n---|---\n1 | x",
    );
  });

  test("a place that does not exist is refused", () => {
    expect(setCell(table(), SOURCE, 9, 0, "x")).toBeNull();
    expect(setCell(table(), SOURCE, 0, 9, "x")).toBeNull();
  });

  test("a trailing backslash cannot swallow the pipe after it", () => {
    const tight = "|a|b|\n|-|-|\n|1|2|";
    expect(setCell(table(tight), tight, 1, 0, "x\\")).toBeNull();
    // With padding after it, it is a plain backslash.
    expect(apply(SOURCE, setCell(table(), SOURCE, 1, 0, "x\\"))).toBe(
      "| a | b |\n|---|:-:|\n| x\\ | 2 |\n| 3 | 4 |",
    );
  });

  test("value and source convert both ways", () => {
    expect(cellValue("a\\|b")).toBe("a|b");
    expect(cellSource("a|b")).toBe("a\\|b");
    expect(cellSource("a\\|b")).toBe("a\\|b");
    expect(cellSource("  a  ")).toBe("a");
  });
});

describe("rows", () => {
  test("a new row goes where asked, with the file's line break", () => {
    expect(apply(SOURCE, addRow(table(), SOURCE, 1, "\n"))).toBe(
      "| a | b |\n|---|:-:|\n| 1 | 2 |\n|   |   |\n| 3 | 4 |",
    );
    expect(apply(SOURCE, addRow(table(), SOURCE, 0, "\n"))).toBe(
      "| a | b |\n|---|:-:|\n|   |   |\n| 1 | 2 |\n| 3 | 4 |",
    );
    expect(addRow(table(), SOURCE, 2, "\r\n")?.[0].insert).toBe(
      "\r\n|   |   |",
    );
  });

  test("a row goes with the line break before it; the header stays", () => {
    expect(apply(SOURCE, removeRow(table(), SOURCE, 2))).toBe(
      "| a | b |\n|---|:-:|\n| 1 | 2 |",
    );
    expect(apply(SOURCE, removeRow(table(), SOURCE, 1))).toBe(
      "| a | b |\n|---|:-:|\n| 3 | 4 |",
    );
    expect(removeRow(table(), SOURCE, 0)).toBeNull();
    expect(removeRow(table(), SOURCE, 9)).toBeNull();
  });
});

describe("columns", () => {
  test("a new column goes before, or at the end, in every row", () => {
    expect(apply(SOURCE, addColumn(table(), SOURCE, 1))).toBe(
      "| a |   | b |\n|---| --- |:-:|\n| 1 |   | 2 |\n| 3 |   | 4 |",
    );
    expect(apply(SOURCE, addColumn(table(), SOURCE, 2))).toBe(
      "| a | b |   |\n|---|:-:| --- |\n| 1 | 2 |   |\n| 3 | 4 |   |",
    );
    const open = "a | b\n---|---\n1 | 2";
    expect(apply(open, addColumn(table(open), open, 2))).toBe(
      "a | b|   |\n---|---| --- |\n1 | 2|   |",
    );
  });

  test("a column goes from every row, and the last one stays", () => {
    expect(apply(SOURCE, removeColumn(table(), SOURCE, 0))).toBe(
      "| b |\n|:-:|\n| 2 |\n| 4 |",
    );
    expect(apply(SOURCE, removeColumn(table(), SOURCE, 1))).toBe(
      "| a |\n|---|\n| 1 |\n| 3 |",
    );
    const one = "| a |\n|---|";
    expect(removeColumn(table(one), one, 0)).toBeNull();
    expect(removeColumn(table(), SOURCE, 9)).toBeNull();
  });
});

describe("every edit keeps every other cell", () => {
  // A small repeatable generator, so a failure can be run again.
  function random(seed: number) {
    let state = seed;
    return (limit: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % limit;
    };
  }
  const WORDS = [
    "a",
    "b c",
    "",
    "**x**",
    "`y`",
    "a\\|b",
    "[[N\\|n]]",
    "é",
    "  z  ",
  ];

  function randomTable(next: (limit: number) => number): string {
    const columns = next(4) + 1;
    const outer = next(4) !== 0;
    const row = (cell: () => string) => {
      const line = Array.from({ length: columns }, cell).join("|");
      return outer ? `|${line}|` : line;
    };
    const cell = () => {
      const word = WORDS[next(WORDS.length)];
      return outer || word !== "" ? ` ${word} ` : " x ";
    };
    const lines = [row(cell), row(() => "---")];
    const count = next(4);
    for (let index = 0; index < count; index += 1) {
      lines.push(row(cell));
    }
    return lines.join("\n");
  }

  test("for many random tables", () => {
    const next = random(42);
    for (let round = 0; round < 500; round += 1) {
      const source = randomTable(next);
      const parsed = parseTable(source);
      if (parsed === null) {
        continue;
      }
      const row = next(parsed.rows.length);
      const column = next(parsed.columns);
      const before = texts(source);

      const cell = setCell(parsed, source, row, column, "neu");
      if (cell !== null) {
        const after = texts(apply(source, cell));
        before[row][column] = "neu";
        expect(after, source).toEqual(before);
        before[row][column] = texts(source)[row][column];
      }

      const added = addRow(parsed, source, row, "\n");
      if (added !== null) {
        expect(texts(apply(source, added)).length, source).toBe(
          before.length + 1,
        );
      }

      const column2 = addColumn(parsed, source, column);
      if (column2 !== null) {
        const after = parseTable(apply(source, column2));
        expect(after?.columns, source).toBe(parsed.columns + 1);
      }

      const removed = removeColumn(parsed, source, column);
      if (removed !== null) {
        const after = parseTable(apply(source, removed));
        expect(after?.columns, source).toBe(parsed.columns - 1);
      }
    }
  });
});
