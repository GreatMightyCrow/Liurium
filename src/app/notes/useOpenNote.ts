import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConflictChoice,
  openNote,
  type OpenedNote,
  resolveNoteConflict,
  updateNote,
} from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";

/** While typing, the text reaches Rust at least this often, so closing the window
 *  saves almost everything even without the page (M3-003). */
export const DRAFT_EVERY_MS = 300;
/** Saving starts this long after the last change (owner decision Q1). */
export const SAVE_AFTER_MS = 1000;

export type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "failed";

export type NoteState =
  | { status: "loading" }
  | { status: "failed"; error: CommandError }
  | {
      status: "ready";
      note: OpenedNote;
      /** Changes when the editor must start over with `note.text`. */
      version: number;
      save: SaveStatus;
      saveError: CommandError | null;
    };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

// One queue for every note command, across notes: the last text of a note always
// reaches Rust before the next note opens.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** Saves the open note now; the window's close button waits for it. */
let flushOpen: (() => Promise<void>) | null = null;
export function flushOpenNote(): Promise<void> {
  return flushOpen?.() ?? Promise.resolve();
}

// Mount it once per note (a `key` on the path), so each note starts loading.
export function useOpenNote(path: string, onMoved: (path: string) => void) {
  const [state, setState] = useState<NoteState>({ status: "loading" });
  const latest = useRef<string | null>(null);
  /** Counts edits, so a save that finished knows whether newer text is waiting. */
  const edits = useRef(0);
  const savedEdit = useRef(0);
  const draftTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const versions = useRef(0);

  const clearTimers = () => {
    for (const timer of [draftTimer, saveTimer]) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    }
  };

  const setReady = useCallback((note: OpenedNote, fresh: boolean) => {
    if (fresh) {
      versions.current += 1;
      latest.current = null;
    }
    setState({
      status: "ready",
      note,
      version: versions.current,
      save: note.conflict ? "conflict" : note.unsaved ? "unsaved" : "saved",
      saveError: null,
    });
  }, []);

  const setSave = (save: SaveStatus, saveError: CommandError | null = null) => {
    setState((last) =>
      last.status === "ready" ? { ...last, save, saveError } : last,
    );
  };

  const save = useCallback((): Promise<void> => {
    clearTimers();
    const text = latest.current;
    if (text === null || savedEdit.current === edits.current) {
      return Promise.resolve();
    }
    const edit = edits.current;
    setSave("saving");
    return enqueue(() => updateNote(path, text, true)).then(
      (result) => {
        if (result === "conflict") {
          setSave("conflict");
          return;
        }
        savedEdit.current = edit;
        setSave(edits.current === edit ? "saved" : "unsaved");
      },
      (reason: unknown) => {
        setSave("failed", errorOf(reason));
      },
    );
  }, [path]);

  const changed = useCallback(
    (text: string) => {
      latest.current = text;
      edits.current += 1;
      setState((last) =>
        last.status === "ready" && last.save !== "conflict"
          ? { ...last, save: "unsaved", saveError: null }
          : last,
      );
      draftTimer.current ??= window.setTimeout(() => {
        draftTimer.current = null;
        const draft = latest.current;
        if (draft !== null) {
          void enqueue(() => updateNote(path, draft, false)).catch(
            () => undefined,
          );
        }
      }, DRAFT_EVERY_MS);
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
      }
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void save();
      }, SAVE_AFTER_MS);
    },
    [path, save],
  );

  useEffect(() => {
    let current = true;
    edits.current = 0;
    savedEdit.current = 0;
    latest.current = null;
    enqueue(() => openNote(path)).then(
      (note) => {
        if (current) {
          setReady(note, true);
        }
      },
      (reason: unknown) => {
        if (current) {
          setState({ status: "failed", error: errorOf(reason) });
        }
      },
    );
    flushOpen = save;
    return () => {
      current = false;
      // Leaving the note (another note, another page): its last text is saved.
      void save();
      if (flushOpen === save) {
        flushOpen = null;
      }
    };
  }, [path, save, setReady]);

  const resolve = useCallback(
    (choice: ConflictChoice): Promise<void> => {
      clearTimers();
      const text = latest.current;
      return enqueue(async () => {
        if (text !== null) {
          await updateNote(path, text, false);
        }
        return resolveNoteConflict(path, choice);
      }).then(
        (note) => {
          savedEdit.current = edits.current;
          if (note.path !== path) {
            onMoved(note.path);
          }
          setReady(note, choice === "reload");
        },
        (reason: unknown) => {
          setSave("conflict", errorOf(reason));
        },
      );
    },
    [onMoved, path, setReady],
  );

  /** Makes mixed line endings uniform; the page asked the user first. */
  const unify = useCallback(
    (): Promise<void> =>
      enqueue(() => openNote(path, true)).then(
        (note) => {
          setReady(note, true);
        },
        (reason: unknown) => {
          setState({ status: "failed", error: errorOf(reason) });
        },
      ),
    [path, setReady],
  );

  return { state, changed, save, resolve, unify };
}
