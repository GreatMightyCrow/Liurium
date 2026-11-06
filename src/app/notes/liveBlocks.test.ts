import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { blocksField, calloutOf, calloutOpen } from "./liveBlocks";

function state(text: string, cursor = 0): EditorState {
  const created = EditorState.create({
    doc: text,
    selection: EditorSelection.single(cursor),
    extensions: [markdown({ base: markdownLanguage }), blocksField],
  });
  ensureSyntaxTree(created, created.doc.length, 5000);
  // The field reads the tree: let it see the finished parse.
  return created.update({}).state;
}

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

describe("callouts", () => {
  test("are read from a quote's first line", () => {
    expect(calloutOf("> [!note] Title")).toEqual({
      kind: "note",
      look: "plain",
      fold: "",
      markerFrom: 2,
      markerTo: 9,
      title: "Title",
    });
    expect(calloutOf(">[!WARNING]-")).toMatchObject({
      kind: "WARNING",
      look: "careful",
      fold: "-",
      title: "",
    });
    expect(calloutOf("  > [!tip]+ x")?.look).toBe("good");
    expect(calloutOf("> [!danger]")?.look).toBe("bad");
    expect(calloutOf("> [!what] x")?.look).toBe("plain");
  });

  test.each(["> quote", "[!note] x", "> [!] x", "> [ !note] x", "> [!note"])(
    "%s is no callout",
    (line) => {
      expect(calloutOf(line)).toBeNull();
    },
  );

  test("- starts closed, + open, none cannot fold", () => {
    const closed = state("> [!note]- T\n> body\n\nend");
    expect(calloutOpen(closed, 0)).toBe(false);
    expect(closed.field(blocksField).folds).toHaveLength(1);
    expect(calloutOpen(state("> [!note]+ T\n> body\n\nend"), 0)).toBe(true);
    expect(calloutOpen(state("> [!note] T\n> body\n\nend"), 0)).toBeNull();
    // Nothing to fold without a body.
    expect(calloutOpen(state("> [!note]- T\n\nend"), 0)).toBeNull();
  });
});

describe("tables", () => {
  test("a top-level table becomes a block", () => {
    const found = state(`x\n\n${TABLE}\n\nend`).field(blocksField);
    expect(found.tables).toEqual([{ from: 3, to: 3 + TABLE.length }]);
  });

  test("in a list, a quote, or the front matter a table stays text", () => {
    for (const text of [
      `- item\n\n  ${TABLE.replace(/\n/g, "\n  ")}`,
      `> ${TABLE.replace(/\n/g, "\n> ")}`,
      `---\n${TABLE}\n---\n`,
    ]) {
      expect(state(text).field(blocksField).tables, text).toEqual([]);
    }
  });

  test("what is not a table stays text", () => {
    expect(state("| a | b |\n| c | d |").field(blocksField).tables).toEqual([]);
  });

  test("a huge table stays text", () => {
    const rows = "\n| 1 | 2 |".repeat(600);
    expect(
      state(`| a | b |\n|---|---|${rows}`).field(blocksField).tables,
    ).toEqual([]);
  });
});

describe("the guard around blocks", () => {
  // With the filter: the field's extension alone has none, so these use the view-free
  // parts that decide; the real keys are in e2e/tables.spec.ts.
  test("a table's range moves with edits above it", () => {
    const before = state(`x\n\n${TABLE}`);
    const after = before.update({ changes: { from: 0, insert: "abc" } }).state;
    expect(after.field(blocksField).tables[0].from).toBe(
      before.field(blocksField).tables[0].from + 3,
    );
  });
});
