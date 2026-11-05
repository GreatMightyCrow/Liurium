import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeNote,
  type ConflictChoice,
  openNote,
  type OpenedNote,
  reconcileNote,
  resolveNoteConflict,
  updateNote,
} from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";

/** While typing, the text reaches Rust at least this often, so closing the window
 *  saves almost everything even without the page (M3-003). */
export const DRAFT_EVERY_MS = 300;
/** Saving starts this long after the last change (owner decision Q1). */
export const SAVE_AFTER_MS = 1000;

/** How long "Updated from outside" shows after an automatic reload (M3-008). */
export const UPDATED_SHOWS_MS = 5000;

export type SaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "conflict"
  | "failed"
  /** The file is gone; nothing is saved until the user chooses (M3-008). */
  | "gone"
  /** Reloaded by itself after a change outside (M3-008). */
  | "updated";

function statusOf(note: OpenedNote): SaveStatus {
  if (note.gone) {
    return "gone";
  }
  if (note.conflict) {
    return "conflict";
  }
  return note.unsaved ? "unsaved" : "saved";
}

/** Saving is on hold until the user chooses. */
function held(save: SaveStatus): boolean {
  return save === "conflict" || save === "gone";
}

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
export function useOpenNote(
  path: string,
  onMoved: (path: string) => void,
  /** The file's new text after an automatic reload, for the editor to take over. */
  onReloaded: (text: string) => void,
) {
  const [state, setState] = useState<NoteState>({ status: "loading" });
  /** The revision the editor's text is based on (M3-008). */
  const revision = useRef(0);
  const lineEnding = useRef<OpenedNote["lineEnding"] | null>(null);
  const updatedTimer = useRef<number | null>(null);
  const reloaded = useRef(onReloaded);
  useEffect(() => {
    reloaded.current = onReloaded;
  });
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
    revision.current = note.revision;
    lineEnding.current = note.lineEnding;
    setState({
      status: "ready",
      note,
      version: versions.current,
      save: statusOf(note),
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
    const basedOn = revision.current;
    setState((last) =>
      last.status === "ready" && !held(last.save)
        ? { ...last, save: "saving", saveError: null }
        : last,
    );
    return enqueue(() => updateNote(path, text, true, basedOn)).then(
      (result) => {
        if (result === "conflict" || result === "gone") {
          setSave(result);
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
        last.status === "ready" && !held(last.save)
          ? { ...last, save: "unsaved", saveError: null }
          : last,
      );
      draftTimer.current ??= window.setTimeout(() => {
        draftTimer.current = null;
        const draft = latest.current;
        const basedOn = revision.current;
        if (draft !== null) {
          void enqueue(() => updateNote(path, draft, false, basedOn)).catch(
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
      if (updatedTimer.current !== null) {
        window.clearTimeout(updatedTimer.current);
      }
      // Leaving the note (another note, another page): its last text is saved.
      void save();
      if (flushOpen === save) {
        flushOpen = null;
      }
    };
  }, [path, save, setReady]);

  /** Looks at the file after a change outside (M3-008, owner decisions Q2 to Q4). The
   *  editor's unsent text goes first, so Rust decides knowing all of it. */
  const reconcile = useCallback((): Promise<void> => {
    const edit = edits.current;
    const text = latest.current;
    const basedOn = revision.current;
    return enqueue(async () => {
      if (text !== null && savedEdit.current !== edit) {
        await updateNote(path, text, false, basedOn);
      }
      return reconcileNote(path);
    }).then(
      ({ outcome, note }) => {
        const typed = edits.current === edit ? null : latest.current;
        if (note.path !== path) {
          // Typed since: it follows the note under its new path.
          if (typed !== null) {
            void enqueue(() =>
              updateNote(note.path, typed, false, note.revision),
            ).catch(() => undefined);
          }
          latest.current = null;
          clearTimers();
          onMoved(note.path);
          return;
        }
        if (outcome === "reloaded") {
          if (typed !== null) {
            // Rust reloaded while the user typed: the editor still shows the old
            // text. Sent with the old revision, it becomes a conflict, not a loss.
            clearTimers();
            setSave("conflict");
            void enqueue(() => updateNote(path, typed, false, basedOn)).catch(
              () => undefined,
            );
            return;
          }
          clearTimers();
          savedEdit.current = edits.current;
          latest.current = null;
          // Another kind of line break needs a new editor; else only the text changes.
          const fresh = lineEnding.current !== note.lineEnding;
          setReady(note, fresh);
          if (!fresh) {
            reloaded.current(note.text);
          }
          setSave("updated");
          if (updatedTimer.current !== null) {
            window.clearTimeout(updatedTimer.current);
          }
          updatedTimer.current = window.setTimeout(() => {
            updatedTimer.current = null;
            setState((last) =>
              last.status === "ready" && last.save === "updated"
                ? { ...last, save: "saved" }
                : last,
            );
          }, UPDATED_SHOWS_MS);
          return;
        }
        setState((last) => {
          if (last.status !== "ready") {
            return last;
          }
          const next = statusOf(note);
          return {
            ...last,
            note: { ...last.note, gone: note.gone, conflict: note.conflict },
            // A plain look changes nothing unless saving was or is now on hold.
            save: held(next) || held(last.save) ? next : last.save,
          };
        });
      },
      () => {
        // The note may have closed meanwhile; the next change looks again.
      },
    );
  }, [onMoved, path, setReady]);

  /** Whether closing now would drop text that was never saved. */
  const hasUnsavedText = (): boolean =>
    state.status === "ready" &&
    (state.note.unsaved ||
      (latest.current !== null && savedEdit.current !== edits.current));

  /** Leaves the note; with `discard`, its unsaved text is dropped (the page asked). */
  const close = useCallback(
    (discard: boolean): Promise<void> => {
      clearTimers();
      if (discard) {
        latest.current = null;
      }
      return enqueue(() => closeNote(path, discard)).then(
        () => undefined,
        (reason: unknown) => {
          setSave("gone", errorOf(reason));
          throw reason;
        },
      );
    },
    [path],
  );

  const resolve = useCallback(
    (choice: ConflictChoice): Promise<void> => {
      clearTimers();
      const text = latest.current;
      const basedOn = revision.current;
      return enqueue(async () => {
        if (text !== null) {
          await updateNote(path, text, false, basedOn);
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
          setState((last) =>
            last.status === "ready"
              ? {
                  ...last,
                  save: last.save === "gone" ? "gone" : "conflict",
                  saveError: errorOf(reason),
                }
              : last,
          );
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

  return {
    state,
    changed,
    save,
    resolve,
    unify,
    reconcile,
    close,
    hasUnsavedText,
  };
}
