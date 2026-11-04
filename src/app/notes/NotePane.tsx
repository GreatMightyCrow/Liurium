import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NoteReadOnly, OpenedNote } from "../../lib/ipc/commands";
import { Button } from "../../ui/Button";
import { Dialog, DialogClose } from "../../ui/Dialog";
import { ErrorState, LoadingState } from "../../ui/StateView";
import { commandErrorMessage } from "../commandErrorMessage";
import { createNoteEditor, type NoteEditor } from "./noteEditor";
import styles from "./NotePane.module.css";
import { type SaveStatus, useOpenNote } from "./useOpenNote";

const readOnlyText: Record<NoteReadOnly, string> = {
  project: "This project is write-protected, so the note opens read-only.",
  file: "This file is write-protected, so the note opens read-only.",
  lineEndings:
    "This note mixes Windows and Unix line endings. It opens read-only until they are made one kind.",
};

export const saveStatusText: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Not saved yet",
  saving: "Saving…",
  conflict: "Changed outside Liurium",
  failed: "Not saved",
};

function split(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut), name: path.slice(cut + 1) };
}

interface NotePaneProps {
  path: string;
  /** The note now lives at another path (keep both). */
  onMoved: (path: string) => void;
}

// The open note (M3-003): name, folder, save status, notices, and the editor.
// Saving is automatic; Ctrl + S saves at once (owner decision Q1).
export function NotePane({ path, onMoved }: NotePaneProps) {
  const { state, changed, save, resolve, unify } = useOpenNote(path, onMoved);
  const { folder, name } = split(path);

  return (
    <section className={styles.pane} aria-label={name}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <h2 className={styles.name}>{name}</h2>
          {folder !== "" && <p className={styles.folder}>{folder}</p>}
        </div>
        {state.status === "ready" && (
          <p className={styles.status} data-status={state.save} role="status">
            {saveStatusText[state.save]}
          </p>
        )}
      </header>
      {state.status === "loading" && <LoadingState label="Opening note…" />}
      {state.status === "failed" && (
        <ErrorState
          title="The note could not be opened"
          description={commandErrorMessage(state.error)}
        />
      )}
      {state.status === "ready" && (
        <>
          {state.saveError !== null && state.save === "failed" && (
            <p className={styles.notice} role="alert">
              {`Not saved. ${commandErrorMessage(state.saveError)} Liurium tries again with your next change, or press Ctrl + S.`}
            </p>
          )}
          {state.save === "conflict" && (
            <ConflictBar name={name} onChoose={resolve} />
          )}
          {state.note.readOnly !== null && (
            <ReadOnlyNotice
              name={name}
              reason={state.note.readOnly}
              onUnify={unify}
            />
          )}
          <EditorHost
            key={`${state.note.path}:${String(state.version)}`}
            note={state.note}
            label={name}
            onChange={changed}
            onSave={() => {
              void save();
            }}
          />
        </>
      )}
    </section>
  );
}

function ConflictBar({
  name,
  onChoose,
}: {
  name: string;
  onChoose: (choice: "reload" | "overwrite" | "keepBoth") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const choose = (choice: "reload" | "overwrite" | "keepBoth") => {
    setBusy(true);
    void onChoose(choice).finally(() => {
      setBusy(false);
      setAsking(false);
    });
  };
  return (
    <div className={styles.conflict} role="alert">
      <p className={styles.conflictText}>
        This note was changed outside Liurium. Your version is kept here but not
        saved until you choose.
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            choose("keepBoth");
          }}
        >
          Keep both
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            choose("overwrite");
          }}
        >
          Keep my version
        </Button>
        <Dialog
          open={asking}
          onOpenChange={setAsking}
          title={`Load “${name}” from disk?`}
          description="Your changes since the last save are dropped, and the note shows the version that was changed outside Liurium."
          trigger={<Button disabled={busy}>Load from disk…</Button>}
          actions={
            <>
              <DialogClose>Cancel</DialogClose>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  choose("reload");
                }}
              >
                Drop my changes
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

function ReadOnlyNotice({
  name,
  reason,
  onUnify,
}: {
  name: string;
  reason: NoteReadOnly;
  onUnify: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.notice} role="status">
      <p className={styles.noticeText}>{readOnlyText[reason]}</p>
      {reason === "lineEndings" && (
        <Dialog
          open={asking}
          onOpenChange={setAsking}
          title={`Use one kind of line ending in “${name}”?`}
          description="Liurium rewrites the line breaks of this note to the kind most of its lines use. The text itself stays the same."
          trigger={<Button size="sm">Use one line ending…</Button>}
          actions={
            <>
              <DialogClose>Cancel</DialogClose>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onUnify().finally(() => {
                    setBusy(false);
                    setAsking(false);
                  });
                }}
              >
                Use one line ending
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function EditorHost({
  note,
  label,
  onChange,
  onSave,
}: {
  note: OpenedNote;
  label: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onChange, onSave });
  // The editor starts once with these; the key on this component starts a new one
  // for a new text.
  const initial = useRef({ note, label });

  useLayoutEffect(() => {
    handlers.current = { onChange, onSave };
  });

  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return;
    }
    const { note, label } = initial.current;
    let editor: NoteEditor | null = createNoteEditor(element, {
      text: note.text,
      lineBreak:
        note.lineEnding === "crlf"
          ? "\r\n"
          : note.lineEnding === "lf"
            ? "\n"
            : null,
      readOnly: note.readOnly !== null,
      label,
      onChange: (text) => {
        handlers.current.onChange(text);
      },
      onSave: () => {
        handlers.current.onSave();
      },
    });
    return () => {
      editor?.destroy();
      editor = null;
    };
  }, []);

  return <div ref={host} className={styles.editor} />;
}
