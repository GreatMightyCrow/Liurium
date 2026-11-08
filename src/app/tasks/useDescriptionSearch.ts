import { useEffect, useState } from "react";
import { type Board, tasksWithDescription } from "../../lib/ipc/commands";

/** Long enough that typing a word asks Rust once. */
export const SEARCH_DELAY_MS = 150;

const NOTHING: ReadonlySet<string> = new Set();

export interface DescriptionSearch {
  ids: ReadonlySet<string>;
  failed: boolean;
}

interface Found extends DescriptionSearch {
  query: string;
}

const NOT_ASKED: DescriptionSearch = { ids: NOTHING, failed: false };

/**
 * The tasks whose description holds `text`, asked from Rust as descriptions are not in
 * the board's answer (M4-008). Asked again when the board changes; an answer that came
 * too late for what is typed now is dropped.
 */
export function useDescriptionSearch(
  text: string,
  board: Board | null,
): DescriptionSearch {
  const [found, setFound] = useState<Found | null>(null);
  const query = text.trim();

  useEffect(() => {
    if (query === "" || board === null) {
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void tasksWithDescription(query).then(
        (ids) => {
          if (current) {
            setFound({ query, ids: new Set(ids), failed: false });
          }
        },
        () => {
          if (current) {
            setFound({ query, ids: NOTHING, failed: true });
          }
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, board]);

  return found?.query === query ? found : NOT_ASKED;
}
