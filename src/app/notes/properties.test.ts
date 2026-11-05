import { expect, test } from "vitest";
import {
  displayText,
  effectiveKind,
  fits,
  itemsOf,
  splitNewItems,
  valueFor,
} from "./properties";
import { textChange } from "./links";

const none = new Map<string, never>();

test("the fixed lists win, then the chosen kind, then the value", () => {
  const date = { kind: "date", text: "2026-01-01" } as const;
  expect(effectiveKind("Tags", date, new Map([["tags", "date"]]))).toBe("list");
  expect(effectiveKind("due", date, new Map([["due", "text"]]))).toBe("text");
  expect(effectiveKind("due", date, none)).toBe("date");
  expect(effectiveKind("due", { kind: "empty" }, none)).toBe("text");
});

test("a value fits a kind only when its control can show it unchanged", () => {
  const text = (value: string) => ({ kind: "text", text: value }) as const;
  expect(fits("date", text("2026-01-01"))).toBe(true);
  expect(fits("date", text("soon"))).toBe(false);
  expect(fits("number", text("12.5"))).toBe(true);
  expect(fits("number", text("12,5"))).toBe(false);
  expect(fits("dateTime", text("2026-01-01T08:30"))).toBe(true);
  expect(fits("checkbox", text("true"))).toBe(false);
  expect(fits("checkbox", { kind: "empty" })).toBe(true);
  expect(fits("text", { kind: "number", text: "5" })).toBe(true);
  expect(fits("text", { kind: "list", items: ["a"] })).toBe(false);
  expect(fits("list", text("one"))).toBe(true);
  expect(fits("list", { kind: "checkbox", checked: true })).toBe(false);
});

test("values turn into text and items without losing anything", () => {
  expect(displayText({ kind: "checkbox", checked: false })).toBe("false");
  expect(displayText({ kind: "list", items: ["a", "b"] })).toBe("a, b");
  expect(itemsOf({ kind: "text", text: "one" })).toEqual(["one"]);
  expect(itemsOf({ kind: "empty" })).toEqual([]);
});

test("a control writes its kind, and nothing typed means empty", () => {
  expect(valueFor("date", "2026-01-01")).toEqual({
    kind: "date",
    text: "2026-01-01",
  });
  expect(valueFor("date", "")).toEqual({ kind: "empty" });
  expect(valueFor("list", "")).toEqual({ kind: "list", items: [] });
  expect(valueFor("checkbox", "")).toEqual({
    kind: "checkbox",
    checked: false,
  });
});

test("a tag list takes several without #; other lists take the line as it is", () => {
  expect(splitNewItems("tags", " #a, b  #c/d ")).toEqual(["a", "b", "c/d"]);
  expect(splitNewItems("friends", " Ann Lee ")).toEqual(["Ann Lee"]);
  expect(splitNewItems("friends", "  ")).toEqual([]);
});

test("a text change keeps what both ends share", () => {
  expect(textChange("a: 1\nb", "a: 22\nb")).toEqual({
    from: 3,
    to: 4,
    insert: "22",
  });
  expect(textChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
  expect(textChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  expect(textChange("old", "")).toEqual({ from: 0, to: 3, insert: "" });
});

test("a text change never cuts a Windows line break in two", () => {
  const lines = textChange("a\r\nc\r\n", "a\r\nb\r\nc\r\n");
  const applied =
    "a\r\nc\r\n".slice(0, lines.from) +
    lines.insert +
    "a\r\nc\r\n".slice(lines.to);
  expect(applied).toBe("a\r\nb\r\nc\r\n");
  const added = textChange("x\r\n", "x\r\ny\r\n");
  expect("x\r\n"[added.from - 1]).not.toBe("\r");
  expect("x\r\n".slice(added.to).startsWith("\n")).toBe(false);
});
