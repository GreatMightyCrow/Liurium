import { expect, test } from "vitest";
import { sameTag, tagRows } from "./tags";

test("a parent tag counts its children's notes, each note once", () => {
  expect(
    tagRows([
      { tag: "topic", notes: ["a.md", "b.md"] },
      { tag: "topic/sub", notes: ["b.md", "c.md"] },
    ]),
  ).toEqual([
    { tag: "topic", notes: ["a.md", "b.md", "c.md"] },
    { tag: "topic/sub", notes: ["b.md", "c.md"] },
  ]);
});

test("a parent that is never written still gets a row", () => {
  expect(tagRows([{ tag: "a/b/c", notes: ["x.md"] }])).toEqual([
    { tag: "a", notes: ["x.md"] },
    { tag: "a/b", notes: ["x.md"] },
    { tag: "a/b/c", notes: ["x.md"] },
  ]);
});

test("children sort right below their parent, without case", () => {
  expect(
    tagRows([
      { tag: "a-b", notes: ["1.md"] },
      { tag: "B", notes: ["2.md"] },
      { tag: "a/z", notes: ["3.md"] },
      { tag: "a", notes: ["4.md"] },
    ]).map((row) => row.tag),
  ).toEqual(["a", "a/z", "a-b", "B"]);
});

test("spellings of one parent share a row", () => {
  expect(
    tagRows([
      { tag: "Topic/one", notes: ["1.md"] },
      { tag: "topic/two", notes: ["2.md"] },
    ]),
  ).toEqual([
    { tag: "Topic", notes: ["1.md", "2.md"] },
    { tag: "Topic/one", notes: ["1.md"] },
    { tag: "topic/two", notes: ["2.md"] },
  ]);
});

test("tags are the same without case", () => {
  expect(sameTag("Idee", "idee")).toBe(true);
  expect(sameTag("idee", "idee/a")).toBe(false);
});
