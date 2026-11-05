import { useEffect, useState } from "react";
import { projectTags, type TagNotes } from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { flushOpenNote } from "./useOpenNote";

// The tags of the project (M3-007). Rust lists each tag as it is written; this adds
// the nesting: `#topic` also counts the notes of `#topic/sub`, and a `topic` row
// exists even if only `#topic/sub` is ever written.

export interface TagRow {
  tag: string;
  notes: string[];
}

export function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const byParts = (a: TagRow, b: TagRow): number => {
  const left = a.tag.split("/");
  const right = b.tag.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = left[i].localeCompare(right[i], "en", {
      sensitivity: "base",
    });
    if (order !== 0) {
      return order;
    }
  }
  return left.length - right.length;
};

export function tagRows(tags: readonly TagNotes[]): TagRow[] {
  const rows = new Map<string, { tag: string; notes: Set<string> }>();
  for (const { tag, notes } of tags) {
    const parts = tag.split("/");
    parts.forEach((_, i) => {
      const name = parts.slice(0, i + 1).join("/");
      const key = name.toLowerCase();
      const row = rows.get(key) ?? { tag: name, notes: new Set<string>() };
      rows.set(key, row);
      notes.forEach((note) => row.notes.add(note));
    });
  }
  return [...rows.values()]
    .map((row) => ({ tag: row.tag, notes: [...row.notes] }))
    .sort(byParts);
}

export type TagsState =
  | { status: "loading" }
  | { status: "ready"; rows: TagRow[] }
  | { status: "failed"; error: CommandError };

/** The project's tags while `active`, asked for again whenever `refresh` changes.
 *  The open note is saved first, so what was just typed counts. The last answer
 *  stays on show until the new one is there. */
export function useProjectTags(active: boolean, refresh: string): TagsState {
  const [state, setState] = useState<TagsState>({ status: "loading" });
  useEffect(() => {
    if (!active) {
      return;
    }
    let current = true;
    flushOpenNote()
      .catch(() => {
        // The note shows its own save failure; the tags still come from the rest.
      })
      .then(projectTags)
      .then(
        (tags) => {
          if (current) {
            setState({ status: "ready", rows: tagRows(tags) });
          }
        },
        (reason: unknown) => {
          if (current) {
            setState({
              status: "failed",
              error:
                reason instanceof CommandFailure
                  ? reason.error
                  : { kind: "internal" },
            });
          }
        },
      );
    return () => {
      current = false;
    };
  }, [active, refresh]);
  return state;
}
