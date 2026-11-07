import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { NoteMath } from "../../lib/ipc/commands";
import { axeViolations } from "../../test/axe";
import {
  definersBefore,
  definersIn,
  liveMath,
  loadMath,
  mathBlocksField,
  mathElement,
  mathKey,
  mathOptions,
  MathWidget,
  setFocused,
} from "./liveMath";
import { dragEnded, mathOf } from "./liveShared";

function formula(tex: string, from = 0, display = false): NoteMath {
  return { from, to: from + tex.length + 2, tex, display };
}

const shown = (
  tex: string,
  definers: readonly string[] = [],
  display = false,
) => mathElement(formula(tex, 100, display), definers);

const isError = (element: HTMLElement) =>
  element.classList.contains("cm-math-error");

beforeAll(async () => {
  await loadMath();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("options", () => {
  test("every option that keeps a formula harmless is set", () => {
    const macros = {};
    expect(mathOptions(true, macros)).toEqual({
      displayMode: true,
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
      output: "htmlAndMathml",
      globalGroup: true,
      macros,
    });
  });
});

describe("drawing", () => {
  test("a formula becomes KaTeX's nodes, with MathML for a screen reader", () => {
    const element = shown("a^2");
    expect(element.className).toBe("cm-math");
    expect(element.querySelector(".katex-html")).not.toBeNull();
    expect(element.querySelector("math")).not.toBeNull();
    expect(isError(element)).toBe(false);
  });

  test("display mode shows as a display formula", () => {
    const element = shown("x", [], true);
    expect(element.classList).toContain("cm-math-display");
    expect(element.querySelector(".katex-display")).not.toBeNull();
  });

  test("\\ce and \\pu work", () => {
    expect(isError(shown("\\ce{H2O}"))).toBe(false);
    expect(isError(shown("\\pu{123 kJ}"))).toBe(false);
  });
});

describe("what KaTeX refuses", () => {
  test.each([
    ["an unknown command", "\\notACommand"],
    ["an open group", "{x"],
    ["a macro loop", "\\def\\x{\\x\\x}\\x"],
    ["a broken chemistry formula", "\\ce{-->{}}}"],
  ])("%s shows its source with the reason", (_what, tex) => {
    const element = shown(tex);
    expect(isError(element)).toBe(true);
    expect(element.textContent).toBe(tex);
    expect(element.title).toMatch(/^Formula not shown: /);
  });

  test("deep nesting ends as an error, not as a crash", () => {
    const tex = "{".repeat(5000) + "x" + "}".repeat(5000);
    expect(() => shown(tex)).not.toThrow();
  });

  test("the reason does not start with KaTeX's name", () => {
    expect(shown("\\notACommand").title).not.toContain("KaTeX");
  });
});

describe("a formula is untrusted", () => {
  test.each([
    ["\\href", "\\href{https://example.org}{x}"],
    ["\\url", "\\url{https://example.org}"],
    ["\\includegraphics", "\\includegraphics{pic.png}"],
    ["\\htmlClass", "\\htmlClass{x}{y}"],
    ["\\htmlData", "\\htmlData{a=b}{y}"],
    ["\\htmlStyle", "\\htmlStyle{color: red}{y}"],
    ["\\htmlId", "\\htmlId{x}{y}"],
  ])("%s gives no link, image, or attribute", (_name, tex) => {
    const element = shown(tex);
    expect(element.querySelector("a, img, [data-a], #x, .x")).toBeNull();
  });

  test("a huge rule stays small", () => {
    const element = shown("\\rule{500em}{500em}");
    const rule = element.querySelector<HTMLElement>(".katex-rule");
    expect(rule?.style.borderRightWidth).toBe("20em");
    expect(rule?.style.borderTopWidth).toBe("20em");
  });

  test.each([
    ["\\message{secret}"],
    ["\\errmessage{secret}"],
    ["\\show\\secret"],
    ["\\let\\say\\message\\say{secret}"],
    ["\\noexpand\\message{secret}"],
    ["\\def\\say{\\message}\\say{secret}"],
    // A warning in strict mode would name the text.
    ["\\text{é}secret"],
    ["\\notACommand{secret}"],
  ])("%s writes nothing to the console", (tex) => {
    const calls = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method),
    );
    shown(tex);
    for (const call of calls) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  test("markup in a formula stays text in its error", () => {
    const element = shown("<img src=x onerror=alert(1)>\\notACommand");
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img");
  });
});

describe("definitions", () => {
  test("a formula sees what formulas above it define", () => {
    expect(isError(shown("\\foo", ["\\def\\foo{x}"]))).toBe(false);
    expect(isError(shown("\\baz", ["\\newcommand{\\baz}{x}"]))).toBe(false);
    expect(isError(shown("\\gfoo", ["\\gdef\\gfoo{x}"]))).toBe(false);
  });

  test("without that definition it is an error, whatever was drawn before", () => {
    shown("\\def\\late{x}\\late", []);
    shown("\\late", ["\\def\\late{x}"]);
    expect(isError(shown("\\late", []))).toBe(true);
  });

  test("what a formula defines is not left behind for the next one with the same definers", () => {
    expect(isError(shown("\\def\\own{x}\\own", ["\\def\\a{1}"]))).toBe(false);
    expect(isError(shown("\\own", ["\\def\\a{1}"]))).toBe(true);
  });

  test("the commands that print stay replaced through a definition above", () => {
    const log = vi.spyOn(console, "log");
    expect(isError(shown("\\say{secret}", ["\\let\\say\\message"]))).toBe(
      false,
    );
    expect(log).not.toHaveBeenCalled();
  });

  test("a definition with a mistake keeps what came before the mistake", () => {
    expect(isError(shown("\\ok", ["\\def\\ok{x}\\notACommand"]))).toBe(false);
  });

  test("only formulas that define something count, and only those above", () => {
    const first = formula("\\def\\a{1}", 0);
    const plain = formula("x^2", 20);
    const second = formula("\\newcommand{\\b}{2}", 40);
    const definers = definersIn([first, plain, second]);
    expect(definers).toEqual([first, second]);
    expect(definersBefore(definers, 0)).toEqual([]);
    expect(definersBefore(definers, 30)).toEqual(["\\def\\a{1}"]);
    expect(definersBefore(definers, 50)).toEqual([
      "\\def\\a{1}",
      "\\newcommand{\\b}{2}",
    ]);
  });

  test("a word that only starts like one does not count", () => {
    expect(definersIn([formula("\\define x"), formula("\\letter")])).toEqual(
      [],
    );
  });

  test("the work per note is capped", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      formula(`\\def\\a{${String(index)}}`, index * 20),
    );
    expect(definersIn(many)).toHaveLength(200);
    const long = Array.from({ length: 3 }, (_, index) =>
      formula(`\\def\\a{${"x".repeat(40_000)}}`, index),
    );
    expect(definersIn(long)).toHaveLength(2);
  });

  test("a new definition above makes a formula look different; its place does not", () => {
    const here = formula("x", 10);
    const moved = formula("x", 90);
    expect(mathKey(here, [])).toBe(mathKey(moved, []));
    expect(mathKey(here, [])).not.toBe(mathKey(here, ["\\def\\a{1}"]));
    expect(new MathWidget(here, []).eq(new MathWidget(moved, []))).toBe(true);
    expect(new MathWidget(here, []).eq(new MathWidget(here, ["a"]))).toBe(
      false,
    );
  });
});

describe("blocks over several lines", () => {
  const BLOCK = "$$\nx\n$$";

  function state(text: string, math: readonly NoteMath[], cursor = 0) {
    const created = EditorState.create({
      doc: text,
      selection: EditorSelection.single(cursor),
      extensions: [
        markdown({ base: markdownLanguage }),
        mathOf.of(() => math),
        liveMath(),
      ],
    });
    ensureSyntaxTree(created, created.doc.length, 5000);
    // The field reads the tree: let it see the finished parse.
    return created.update({}).state;
  }

  const blocks = (current: EditorState) =>
    current.field(mathBlocksField).blocks;

  const block = (text: string, tex = "\nx\n"): NoteMath => {
    const from = text.indexOf(BLOCK);
    return { from, to: from + BLOCK.length, tex, display: true };
  };

  test("a block at the top level shows while the editor has no focus", () => {
    const text = `a\n\n${BLOCK}\n\nb`;
    expect(blocks(state(text, [block(text)]))).toHaveLength(1);
  });

  test("the source returns only with focus and the cursor on it", () => {
    const text = `a\n\n${BLOCK}\n\nb`;
    const math = block(text);
    const onIt = state(text, [math], math.from + 1);
    expect(blocks(onIt)).toHaveLength(1);
    const focused = onIt.update({ effects: setFocused.of(true) }).state;
    expect(blocks(focused)).toEqual([]);
    expect(
      blocks(focused.update({ effects: setFocused.of(false) }).state),
    ).toHaveLength(1);
    const elsewhere = state(text, [math], 0);
    expect(
      blocks(elsewhere.update({ effects: setFocused.of(true) }).state),
    ).toHaveLength(1);
  });

  test("the source returns with the cursor and leaves with it", () => {
    const text = `a\n\n${BLOCK}\n\nb`;
    const math = block(text);
    const focused = state(text, [math], 0).update({
      effects: setFocused.of(true),
    }).state;
    const inside = focused.update({ selection: { anchor: math.to } }).state;
    expect(blocks(inside)).toEqual([]);
    const after = inside.update({ selection: { anchor: math.to + 1 } }).state;
    expect(blocks(after)).toHaveLength(1);
  });

  test("a selection being dragged reveals only once the mouse is up", () => {
    const text = `a\n\n${BLOCK}\n\nb`;
    const math = block(text);
    const focused = state(text, [math], 0).update({
      effects: setFocused.of(true),
    }).state;
    const dragged = focused.update({
      selection: { anchor: 0, head: math.to },
      userEvent: "select.pointer",
    }).state;
    expect(blocks(dragged)).toHaveLength(1);
    expect(
      blocks(dragged.update({ effects: dragEnded.of(null) }).state),
    ).toEqual([]);
  });

  test("a press that only places the cursor reveals at once", () => {
    const text = `a\n\n${BLOCK}\n\nb`;
    const math = block(text);
    const focused = state(text, [math], 0).update({
      effects: setFocused.of(true),
    }).state;
    const pressed = focused.update({
      selection: { anchor: math.from },
      userEvent: "select.pointer",
    }).state;
    expect(blocks(pressed)).toEqual([]);
  });

  test.each([
    ["in a quote", `> ${BLOCK.split("\n").join("\n> ")}\n`],
    ["in a list", `- a\n\n  ${BLOCK.split("\n").join("\n  ")}\n`],
    ["right under a list item", `- a\n${BLOCK}\n`],
    ["right under a quote", `> a\n${BLOCK}\n`],
  ])("%s it stays source", (_where, text) => {
    const from = text.indexOf("$$");
    const to = text.lastIndexOf("$$") + 2;
    const current = state(text, [{ from, to, tex: "x", display: true }]);
    expect(blocks(current)).toEqual([]);
  });

  test("a block whose lines hold more stays source", () => {
    const text = `a ${BLOCK} b`;
    expect(blocks(state(text, [block(text)]))).toEqual([]);
  });

  test("an inline formula over two lines stays source", () => {
    const text = "$a\nb$";
    const current = state(text, [
      { from: 0, to: 5, tex: "a\nb", display: false },
    ]);
    expect(blocks(current)).toEqual([]);
  });

  test("the front matter holds no block", () => {
    const text = `---\n${BLOCK}\n---\n`;
    expect(blocks(state(text, [block(text)]))).toEqual([]);
  });

  test("a place that no longer exists is no block", () => {
    const current = state("a", [{ from: 0, to: 50, tex: "x", display: true }]);
    expect(blocks(current)).toEqual([]);
  });
});

describe("accessibility", () => {
  test("a formula and an error have no axe violations", async () => {
    const host = document.createElement("main");
    host.append(shown("a^2"), shown("\\notACommand"));
    document.body.appendChild(host);
    expect(await axeViolations()).toEqual([]);
    host.remove();
  });
});
