import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createNote,
  type LinkCandidate,
  type NoteEntry,
  type NoteLink,
  noteLinks,
  type NoteReadOnly,
  type OpenedNote,
} from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { RadioGroup } from "../../ui/RadioGroup";
import { Backlinks } from "./Backlinks";
import { anchorIndex, inEditor, toEditorPositions } from "./links";
import { Button } from "../../ui/Button";
import { Dialog, DialogClose } from "../../ui/Dialog";
import { ErrorState, LoadingState } from "../../ui/StateView";
import { commandErrorMessage } from "../commandErrorMessage";
import {
  createNoteEditor,
  type NoteEditor,
  type Suggestion,
} from "./noteEditor";
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
  /** The project's notes, offered after `[[` (M3-005). */
  notes: readonly NoteEntry[];
  /** Opens another note (a followed link). */
  onOpen: (path: string) => void;
  /** A note was created from a missing link; the list shows it after a reload. */
  onCreated: () => void;
  /** Shown before the note's name, e.g. the button that shows the note list. */
  leading?: ReactNode;
}

/** While typing, the links are asked for again at most this often. */
export const LINKS_EVERY_MS = 300;

/** A heading or block to show once its note opens (a followed link). */
let pendingAnchor: {
  path: string;
  heading: string | null;
  block: string | null;
  /** A place in the text (UTF-16), from a backlink (M3-006). */
  offset: number | null;
} | null = null;

type LinkQuestion =
  | { kind: "ambiguous"; link: NoteLink; candidates: LinkCandidate[] }
  | { kind: "missing"; path: string };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

function suggestionsOf(notes: readonly NoteEntry[]): Suggestion[] {
  return notes.map((note) => {
    const { folder, name } = split(note.path);
    return {
      name: name.replace(/\.(md|markdown)$/i, ""),
      folder,
      link: note.link,
    };
  });
}

// The open note (M3-003): name, folder, save status, notices, and the editor.
// Saving is automatic; Ctrl + S saves at once (owner decision Q1).
export function NotePane({
  path,
  onMoved,
  notes,
  onOpen,
  onCreated,
  leading,
}: NotePaneProps) {
  const { state, changed, save, resolve, unify } = useOpenNote(path, onMoved);
  const { folder, name } = split(path);
  const editor = useRef<NoteEditor | null>(null);
  const linkTimer = useRef<number | null>(null);
  const [question, setQuestion] = useState<LinkQuestion | null>(null);
  const suggestions = useRef<Suggestion[]>([]);

  useLayoutEffect(() => {
    suggestions.current = suggestionsOf(notes);
  }, [notes]);

  useEffect(
    () => () => {
      if (linkTimer.current !== null) {
        window.clearTimeout(linkTimer.current);
      }
    },
    [],
  );

  /** Rust's links for this text; dropped when the text changed meanwhile. */
  const refreshLinks = (text: string) => {
    noteLinks(path, text).then(
      (links) => {
        const current = editor.current;
        if (current !== null && current.text() === text) {
          current.setLinks(inEditor(text, links));
        }
      },
      () => {
        // Without links the note still edits and saves; they come with the next change.
      },
    );
  };

  const jumpTo = (anchor: { heading: string | null; block: string | null }) => {
    const current = editor.current;
    if (current === null) {
      return;
    }
    const text = current.text();
    const index = anchorIndex(text, anchor);
    if (index !== null) {
      current.goTo(toEditorPositions(text, [index])[0]);
    }
  };

  const follow = (link: NoteLink) => {
    const target = link.target;
    if (target.state === "note") {
      const anchor = { heading: target.heading, block: target.block };
      if (target.path.toLowerCase() === path.toLowerCase()) {
        jumpTo(anchor);
      } else {
        pendingAnchor = { path: target.path, ...anchor, offset: null };
        onOpen(target.path);
      }
    } else if (target.state === "ambiguous") {
      setQuestion({ kind: "ambiguous", link, candidates: target.candidates });
    } else if (target.state === "missing") {
      setQuestion({ kind: "missing", path: target.path });
    }
  };

  const ready = (instance: NoteEditor | null) => {
    editor.current = instance;
    if (instance === null) {
      return;
    }
    refreshLinks(instance.text());
    if (
      pendingAnchor !== null &&
      pendingAnchor.path.toLowerCase() === path.toLowerCase()
    ) {
      const anchor = pendingAnchor;
      pendingAnchor = null;
      if (anchor.offset === null) {
        jumpTo(anchor);
      } else {
        const text = instance.text();
        instance.goTo(toEditorPositions(text, [anchor.offset])[0]);
      }
    }
  };

  const edited = (text: string) => {
    changed(text);
    linkTimer.current ??= window.setTimeout(() => {
      linkTimer.current = null;
      const current = editor.current;
      if (current !== null) {
        refreshLinks(current.text());
      }
    }, LINKS_EVERY_MS);
  };

  return (
    <section className={styles.pane} aria-label={name}>
      <header className={styles.header}>
        {leading}
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
            onChange={edited}
            onSave={() => {
              void save();
            }}
            onFollow={follow}
            suggestions={() => suggestions.current}
            onReady={ready}
          />
          <Backlinks
            path={state.note.path}
            onOpenAt={(source, offset) => {
              pendingAnchor = {
                path: source,
                heading: null,
                block: null,
                offset,
              };
              onOpen(source);
            }}
          />
        </>
      )}
      {question?.kind === "ambiguous" && (
        <AmbiguousDialog
          candidates={question.candidates}
          onClose={() => {
            setQuestion(null);
          }}
          onChoose={(candidate) => {
            setQuestion(null);
            editor.current?.replace(
              question.link.from,
              question.link.to,
              candidate.replacement,
            );
            onOpen(candidate.path);
          }}
        />
      )}
      {question?.kind === "missing" && (
        <MissingDialog
          path={question.path}
          onClose={() => {
            setQuestion(null);
          }}
          onCreate={() => {
            const parts = split(question.path);
            return createNote(parts.folder, parts.name).then((created) => {
              setQuestion(null);
              onCreated();
              onOpen(created);
            });
          }}
        />
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

function AmbiguousDialog({
  candidates,
  onChoose,
  onClose,
}: {
  candidates: readonly LinkCandidate[];
  onChoose: (candidate: LinkCandidate) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState(candidates[0]?.path ?? "");
  return (
    <Dialog
      open
      title="Which note does this link mean?"
      description="Several notes have this name. Liurium writes the chosen one's path into the link, so it is clear from now on."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            variant="primary"
            onClick={() => {
              const candidate = candidates.find((c) => c.path === chosen);
              if (candidate !== undefined) {
                onChoose(candidate);
              }
            }}
          >
            Use this note
          </Button>
        </>
      }
    >
      <RadioGroup
        label="Notes"
        value={chosen}
        options={candidates.map((candidate) => ({
          value: candidate.path,
          label: candidate.path,
        }))}
        onChange={setChosen}
      />
    </Dialog>
  );
}

function MissingDialog({
  path,
  onCreate,
  onClose,
}: {
  path: string;
  onCreate: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { folder, name } = split(path);
  return (
    <Dialog
      open
      title={`Create “${name}”?`}
      description={`No note has this name yet. Liurium creates it ${folder === "" ? "at the top of the project" : `in “${folder}”`} and opens it.`}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onCreate().catch((reason: unknown) => {
                setBusy(false);
                setError(commandErrorMessage(errorOf(reason)));
              });
            }}
          >
            Create note
          </Button>
        </>
      }
    >
      {error !== null && (
        <p className={styles.dialogError} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function EditorHost({
  note,
  label,
  onChange,
  onSave,
  onFollow,
  suggestions,
  onReady,
}: {
  note: OpenedNote;
  label: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onFollow: (link: NoteLink) => void;
  suggestions: () => readonly Suggestion[];
  onReady: (editor: NoteEditor | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onChange, onSave, onFollow, suggestions, onReady });
  // The editor starts once with these; the key on this component starts a new one
  // for a new text.
  const initial = useRef({ note, label });

  useLayoutEffect(() => {
    handlers.current = { onChange, onSave, onFollow, suggestions, onReady };
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
      onFollow: (link) => {
        handlers.current.onFollow(link);
      },
      suggestions: () => handlers.current.suggestions(),
    });
    handlers.current.onReady(editor);
    return () => {
      handlers.current.onReady(null);
      editor?.destroy();
      editor = null;
    };
  }, []);

  return <div ref={host} className={styles.editor} />;
}
