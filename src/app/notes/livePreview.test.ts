import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import type { NoteImage, NoteLink } from "../../lib/ipc/commands";
import { ImageWidget } from "./liveImages";
import { previewRanges } from "./livePreview";

function state(text: string, cursor = text.length): EditorState {
  const created = EditorState.create({
    doc: text,
    selection: EditorSelection.single(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(created, created.doc.length, 5000);
  return created;
}

interface Look {
  hidden: string[];
  widgets: string[];
  lines: string[];
  marks: string[];
}

function look(
  text: string,
  cursor = text.length,
  links: readonly NoteLink[] = [],
): Look {
  const current = state(text, cursor);
  const ranges = previewRanges(
    current,
    [{ from: 0, to: current.doc.length }],
    links,
  );
  const found: Look = { hidden: [], widgets: [], lines: [], marks: [] };
  for (const { from, to, value } of ranges) {
    const spec = value.spec as { widget?: object; class?: string };
    if (spec.widget !== undefined) {
      found.widgets.push(current.sliceDoc(from, to));
    } else if (spec.class !== undefined && from === to) {
      found.lines.push(spec.class);
    } else if (spec.class !== undefined) {
      found.marks.push(current.sliceDoc(from, to));
    } else {
      found.hidden.push(current.sliceDoc(from, to));
    }
  }
  return found;
}

describe("images show while the cursor is elsewhere", () => {
  const image = (from: number, to: number): NoteImage => ({
    from,
    to,
    alt: "a",
    width: null,
    height: null,
    source: {
      state: "local",
      address: "http://liurium-image.localhost/p/a.png",
    },
  });
  const shown = (
    text: string,
    images: readonly NoteImage[],
    cursor = text.length,
    focused = true,
  ) => {
    const current = state(text, cursor);
    return previewRanges(
      current,
      [{ from: 0, to: current.doc.length }],
      [],
      focused,
      images,
    ).flatMap(({ from, to, value }) =>
      (value.spec as { widget?: object }).widget instanceof ImageWidget
        ? [current.sliceDoc(from, to)]
        : [],
    );
  };
  const SOURCE = "![a](a.png)";

  test("the image replaces its source", () => {
    const text = `x ${SOURCE} y\n\nend`;
    expect(shown(text, [image(2, 2 + SOURCE.length)])).toEqual([SOURCE]);
  });

  test("the source comes back at the cursor, at both its ends too", () => {
    const text = `x ${SOURCE} y\n\nend`;
    const found = [image(2, 2 + SOURCE.length)];
    expect(shown(text, found, 5)).toEqual([]);
    expect(shown(text, found, 2)).toEqual([]);
    expect(shown(text, found, 2 + SOURCE.length)).toEqual([]);
    expect(shown(text, found, 1)).toEqual([SOURCE]);
  });

  test("without focus there is no cursor, so a note opens with its images", () => {
    expect(shown(SOURCE, [image(0, SOURCE.length)], 0, false)).toEqual([
      SOURCE,
    ]);
  });

  test("one written across two lines stays source, as a plugin cannot replace a line break", () => {
    const text = "![a\nb](a.png)\n\nend";
    expect(shown(text, [image(0, 13)])).toEqual([]);
  });

  test("inside the front matter nothing shows", () => {
    const text = `---\nx: ${SOURCE}\n---\n\nend`;
    expect(shown(text, [image(7, 7 + SOURCE.length)])).toEqual([]);
  });

  test("a place Rust reported past the text is ignored", () => {
    expect(shown("short", [image(100, 110)], 0)).toEqual([]);
  });

  test("next to a link's marks, inside a link", () => {
    const text = `[${SOURCE}](https://example.com)\n\nend`;
    const current = state(text);
    const ranges = previewRanges(
      current,
      [{ from: 0, to: current.doc.length }],
      [
        {
          from: 0,
          to: text.indexOf("\n"),
          target: {
            state: "external",
            address: "https://example.com",
            claims: null,
          },
        },
      ],
      true,
      [image(1, 1 + SOURCE.length)],
    );
    // A set of these with overlapping replacements would throw.
    expect(() => Decoration.set(ranges, true)).not.toThrow();
    expect(
      ranges.map(({ from, to }) => current.sliceDoc(from, to)).sort(),
    ).toEqual([SOURCE, "[", "](https://example.com)"].sort());
  });
});

function note(from: number, to: number): NoteLink {
  return { from, to, target: { state: "missing", path: "x.md" } };
}

const AWAY = "\n\nend";

describe("marks hide while the cursor is elsewhere", () => {
  test.each([
    ["**bold**", ["**", "**"]],
    ["*italic*", ["*", "*"]],
    ["__bold__", ["__", "__"]],
    ["~~gone~~", ["~~", "~~"]],
    ["`code`", ["`", "`"]],
    ["# Title", ["# "]],
    ["### Title ###", ["### ", "###"]],
    ["> quoted", ["> "]],
  ])("%s", (text, hidden) => {
    expect(look(text + AWAY).hidden).toEqual(hidden);
  });

  test("and come back while the cursor touches the element", () => {
    expect(look(`**bold**${AWAY}`, 3).hidden).toEqual([]);
    // At either edge too, so the arrow keys walk into the marks.
    expect(look(`**bold**${AWAY}`, 0).hidden).toEqual([]);
    expect(look(`**bold**${AWAY}`, 8).hidden).toEqual([]);
    expect(look(`# Title${AWAY}`, 5).hidden).toEqual([]);
  });

  test("only the touched element reveals in a line", () => {
    const text = `**a** and **b**${AWAY}`;
    expect(look(text, 2).hidden).toEqual(["**", "**"]);
  });

  test("a selection reveals what it touches", () => {
    const text = "**a** x **b**";
    const current = EditorState.create({
      doc: text,
      selection: EditorSelection.single(0, text.length),
      extensions: [markdown({ base: markdownLanguage })],
    });
    ensureSyntaxTree(current, current.doc.length, 5000);
    expect(previewRanges(current, [{ from: 0, to: text.length }], [])).toEqual(
      [],
    );
  });
});

test("without focus no marks come back: a note just opened reads as formatted", () => {
  const current = state("# Title\n\n- [ ] task", 0);
  const hiddenAtStart = previewRanges(
    current,
    [{ from: 0, to: current.doc.length }],
    [],
    false,
  ).map(({ from, to }) => current.sliceDoc(from, to));
  expect(hiddenAtStart).toContain("# ");
});

describe("blocks", () => {
  test("headings and quotes style their lines", () => {
    expect(look(`# T${AWAY}`).lines).toEqual(["cm-heading cm-heading-1"]);
    expect(look(`T\n===${AWAY}`).lines).toEqual([
      "cm-heading cm-heading-1",
      "cm-heading cm-heading-1",
    ]);
    expect(look(`> a\n> b${AWAY}`).lines).toEqual(["cm-quote", "cm-quote"]);
  });

  test("a bullet is drawn, an ordered number stays", () => {
    expect(look(`- a\n* b${AWAY}`).widgets).toEqual(["-", "*"]);
    expect(look(`1. a${AWAY}`).widgets).toEqual([]);
    expect(look(`- a${AWAY}`, 3).widgets).toEqual(["-"]);
    // The cursor on the mark shows it.
    expect(look(`- a${AWAY}`, 0).widgets).toEqual([]);
  });

  test("a task shows a box and hides its bullet", () => {
    const found = look(`- [ ] a\n- [x] b${AWAY}`);
    expect(found.widgets).toEqual(["[ ]", "[x]"]);
    expect(found.hidden).toEqual(["- ", "- "]);
    const atBox = look(`- [ ] a${AWAY}`, 3);
    expect(atBox.widgets).toEqual([]);
    expect(atBox.hidden).toEqual([]);
  });

  test("a rule is drawn unless the cursor is on its line", () => {
    expect(look(`a\n\n---${AWAY}`).widgets).toEqual(["---"]);
    expect(look(`a\n\n---${AWAY}`, 4).widgets).toEqual([]);
  });

  test("a code block hides its fences and nothing inside", () => {
    const found = look(`\`\`\`js\n**x** # y\n\`\`\`${AWAY}`);
    expect(found.hidden).toEqual(["```js", "```"]);
    expect(found.lines).toEqual([
      "cm-code-block",
      "cm-code-block",
      "cm-code-block",
    ]);
    expect(look(`\`\`\`js\nx\n\`\`\`${AWAY}`, 7).hidden).toEqual([]);
  });

  test("an unclosed code block runs on and hides only its opening", () => {
    expect(look("```\nx\n\ny", 0).hidden).toEqual([]);
    expect(look("a\n\n```\nx", 0).hidden).toEqual(["```"]);
  });

  test("the front matter is no Markdown", () => {
    const front = "---\ntitle: **x**\n---\n";
    expect(look(`${front}**b**${AWAY}`).hidden).toEqual(["**", "**"]);
    expect(look(`${front}${AWAY}`).widgets).toEqual([]);
    expect(look(`${front}${AWAY}`).lines).toEqual([]);
  });

  test("images stay as written for now", () => {
    const empty = { hidden: [], widgets: [], lines: [], marks: [] };
    expect(look(`![alt **x**](a.png)${AWAY}`)).toEqual(empty);
  });

  test("a callout shows its look and hides its marker", () => {
    const found = look(`> [!warning] Careful\n> text${AWAY}`);
    expect(found.lines).toEqual([
      "cm-callout cm-callout-careful",
      "cm-callout cm-callout-careful",
      "cm-callout-title",
    ]);
    expect(found.hidden).toEqual(["[!warning] ", "> ", "> "]);
    // The marker comes back on its line.
    expect(look(`> [!note] T\n> x${AWAY}`, 3).hidden).toEqual(["> ", "> "]);
  });

  test("a callout without a title shows its kind; a plain quote stays a quote", () => {
    expect(look(`> [!TIP]${AWAY}`).widgets).toEqual(["[!TIP]"]);
    expect(look(`> [not a callout]${AWAY}`).lines).toEqual(["cm-quote"]);
    expect(look(`> [!odd-kind] x${AWAY}`).lines[0]).toBe(
      "cm-callout cm-callout-plain",
    );
  });
});

describe("links", () => {
  test("a link Rust accepts shows only its text", () => {
    const text = `[a](b.md "t")${AWAY}`;
    expect(look(text, text.length, [note(0, 13)]).hidden).toEqual([
      "[",
      '](b.md "t")',
    ]);
    expect(look(text, 5, [note(0, 13)]).hidden).toEqual([]);
  });

  test("a link Rust does not accept keeps its source readable", () => {
    const text = `[x](javascript:alert(1))${AWAY}`;
    expect(look(text).hidden).toEqual([]);
    expect(
      look(text, text.length, [{ from: 0, to: 24, target: { state: "other" } }])
        .hidden,
    ).toEqual([]);
  });

  test("an autolink loses its brackets", () => {
    const text = `<https://a.example>${AWAY}`;
    expect(look(text, text.length, [note(0, 19)]).hidden).toEqual(["<", ">"]);
  });

  test("a wikilink shows its target or its own text", () => {
    const plain = `[[Plan]]${AWAY}`;
    expect(look(plain, plain.length, [note(0, 8)]).hidden).toEqual([
      "[[",
      "]]",
    ]);
    const named = `[[Plan#Top|the plan]]${AWAY}`;
    expect(look(named, named.length, [note(0, 21)]).hidden).toEqual([
      "[[Plan#Top|",
      "]]",
    ]);
    expect(look(plain, 3, [note(0, 8)]).hidden).toEqual([]);
  });

  test("an embed stays as written", () => {
    const text = `![[Plan]]${AWAY}`;
    expect(look(text, text.length, [note(0, 9)]).hidden).toEqual([]);
  });
});

describe("only the view changes", () => {
  test.each([
    "",
    "\n",
    "plain",
    "# T\r\n\r\n**b**\r\n",
    "- [ ] a\n  - b\n\n> q\n\n---\n",
    "```\nunclosed",
    "****",
    "*",
    "[",
    "[]()",
    "[[",
    "---",
    "---\n",
    "---\na: 1",
    "> > nested\n> ",
    "|",
  ])("%j gives ranges that stay inside the text, for every cursor", (text) => {
    // CodeMirror counts a line break as one, also \r\n.
    const length = EditorState.create({ doc: text }).doc.length;
    for (let cursor = 0; cursor <= length; cursor += 1) {
      const current = state(text, cursor);
      for (const { from, to } of previewRanges(
        current,
        [{ from: 0, to: current.doc.length }],
        [],
      )) {
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThanOrEqual(current.doc.length);
        expect(to).toBeGreaterThanOrEqual(from);
      }
    }
  });
});
