import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { anchorIndex, slug, toEditorPositions } from "./links";
import { linkCompletions } from "./noteEditor";

test("each earlier CRLF is one editor position less", () => {
  const text = "a\r\nb\r\nc[[x]]";
  expect(toEditorPositions(text, [7, 12, 0, 3])).toEqual([5, 10, 0, 2]);
  expect(toEditorPositions("a\nb[[x]]", [3])).toEqual([3]);
});

test("headings are found by text or by slug, blocks by their id", () => {
  const text = "# Plan\r\n\r\n## Next steps ##\r\nText ^b1\r\n";
  expect(anchorIndex(text, { heading: "next steps", block: null })).toBe(10);
  expect(anchorIndex(text, { heading: "next-steps", block: null })).toBe(10);
  expect(anchorIndex(text, { heading: null, block: "b1" })).toBe(28);
  expect(anchorIndex(text, { heading: "Missing", block: null })).toBeNull();
  expect(slug("Ünïcödé & Co.!")).toBe("ünïcödé--co");
});

const suggestions = () => [
  { name: "Plan", folder: "Ideas", link: "Ideas/Plan" },
  { name: "Unique", folder: "", link: "Unique" },
];

function complete(doc: string) {
  const state = EditorState.create({ doc });
  const source = linkCompletions(suggestions);
  return source(new CompletionContext(state, doc.length, false));
}

test("suggestions start after [[ and stop at ]], | or #", () => {
  const result = complete("See [[Pl");
  expect(result?.from).toBe(6);
  expect(result?.options.map((option) => option.label)).toEqual([
    "Plan",
    "Unique",
  ]);
  expect(result?.options[0].detail).toBe("Ideas");

  expect(complete("See [Pl")).toBeNull();
  expect(complete("See [[Plan|text")).toBeNull();
  expect(complete("See [[Plan#He")).toBeNull();
  expect(complete("See [[Plan]] more")).toBeNull();
});
