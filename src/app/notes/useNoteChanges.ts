import { useEffect, useRef } from "react";
import { checkNoteChanges, waitNoteChanges } from "../../lib/ipc/commands";

/** After a failed wait, for example while the app data folder is unusable. */
const RETRY_AFTER_MS = 5000;

// Calls `onChange` whenever notes changed outside Liurium (M3-008). Rust answers a
// waiting call when a change was found, so nothing runs while nothing changes. The
// window getting focus makes Rust look too, because Windows' reports can fail on
// network and USB drives (owner decision Q1).
export function useNoteChanges(onChange: () => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  useEffect(() => {
    let current = true;
    let seen = 0;
    let retry: number | null = null;

    const wait = () => {
      waitNoteChanges(seen).then(
        (count) => {
          if (!current) {
            return;
          }
          if (count !== seen) {
            seen = count;
            latest.current();
          }
          wait();
        },
        () => {
          if (current) {
            retry = window.setTimeout(wait, RETRY_AFTER_MS);
          }
        },
      );
    };
    wait();

    const focused = () => {
      checkNoteChanges().catch(() => {
        // The next focus or report tries again; nothing depends on this one.
      });
    };
    window.addEventListener("focus", focused);
    return () => {
      current = false;
      if (retry !== null) {
        window.clearTimeout(retry);
      }
      window.removeEventListener("focus", focused);
    };
  }, []);
}
