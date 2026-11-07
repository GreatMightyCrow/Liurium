import type { NoteTag } from "../../lib/ipc/commands";

// Links in the editor (M3-005). Rust reports ranges in UTF-16 units of the text it
// got, which has the file's line breaks; CodeMirror counts every line break as one
// position, so a CRLF note needs one position less per earlier "\r\n".

/** Rust's UTF-16 offsets in `text` to CodeMirror positions. */
export function toEditorPositions(
  text: string,
  offsets: readonly number[],
): number[] {
  const order = offsets
    .map((offset, index) => ({ offset, index }))
    .sort((a, b) => a.offset - b.offset);
  const result = new Array<number>(offsets.length).fill(0);
  let crlf = 0;
  let at = 0;
  for (const { offset, index } of order) {
    while (at < offset) {
      if (text[at] === "\r" && text[at + 1] === "\n" && at + 1 < offset) {
        crlf += 1;
      }
      at += 1;
    }
    result[index] = offset - crlf;
  }
  return result;
}

/** Links, tags, images, or formulas with their ranges in CodeMirror positions. */
export function inEditor<Placed extends { from: number; to: number }>(
  text: string,
  found: readonly Placed[],
): Placed[] {
  const positions = toEditorPositions(
    text,
    found.flatMap((each) => [each.from, each.to]),
  );
  return found.map((each, i) => ({
    ...each,
    from: positions[2 * i],
    to: positions[2 * i + 1],
  }));
}

/** One change that turns `from` into `to`, keeping what they share at both ends and
 *  never cutting a Windows line break in two. Offsets are in `from`, in UTF-16. */
export function textChange(
  from: string,
  to: string,
): { from: number; to: number; insert: string } {
  const longest = Math.min(from.length, to.length);
  let start = 0;
  while (start < longest && from[start] === to[start]) {
    start += 1;
  }
  if (start > 0 && from[start - 1] === "\r" && from[start] === "\n") {
    start -= 1;
  }
  let tail = 0;
  while (
    tail < longest - start &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail += 1;
  }
  if (
    tail > 0 &&
    from[from.length - tail] === "\n" &&
    from[from.length - tail - 1] === "\r"
  ) {
    tail -= 1;
  }
  return {
    from: start,
    to: from.length - tail,
    insert: to.slice(start, to.length - tail),
  };
}

/** The tags to show for a note: front matter first, then the text's, each once
 *  (without case). */
export function noteTagsOf(
  frontTags: readonly string[],
  tags: readonly NoteTag[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of [...frontTags, ...tags.map((t) => t.tag)]) {
    if (!seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      result.push(tag);
    }
  }
  return result;
}

/** GitHub-style slug: `Next steps` → `next-steps`. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Where a heading or block starts in a note's text (string index), or `null`. */
export function anchorIndex(
  text: string,
  anchor: { heading: string | null; block: string | null },
): number | null {
  let index = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    if (anchor.heading !== null) {
      const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(bare);
      if (
        match !== null &&
        (match[1].toLowerCase() === anchor.heading.toLowerCase() ||
          slug(match[1]) === anchor.heading.toLowerCase())
      ) {
        return index;
      }
    }
    if (anchor.block !== null && bare.endsWith(` ^${anchor.block}`)) {
      return index;
    }
    index += line.length;
  }
  return null;
}
