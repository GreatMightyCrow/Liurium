import { FileText, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  taskDetail,
  type TaskFields,
  type TaskPriority,
} from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { useNotify } from "../../ui/Notifications";
import { RadioGroup } from "../../ui/RadioGroup";
import { ErrorState, LoadingState } from "../../ui/StateView";
import { TextField } from "../../ui/TextField";
import { commandErrorMessage } from "../commandErrorMessage";
import styles from "./TaskPanel.module.css";

/** Typing waits this long, so one change is not saved letter by letter. */
export const SAVE_DELAY_MS = 500;

const SUGGESTIONS = 6;

const PRIORITIES = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const satisfies readonly { value: TaskPriority; label: string }[];

type Status =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "noTitle" }
  | { kind: "failed"; error: CommandError };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

function same(one: TaskFields | null, other: TaskFields | null): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

interface TaskPanelProps {
  task: string;
  /** All notes of the project, to pick from and to see which links are missing. */
  notes: readonly string[];
  readOnly: boolean;
  save: (task: string, fields: TaskFields) => Promise<CommandError | null>;
  onClose: () => void;
  onTrash: (task: string) => void;
  onOpenNote: (path: string) => void;
}

// Everything about one task, beside the board (M4-004). Changes save by themselves,
// as in a note; what could not be saved stays in the fields and says why.
export function TaskPanel({
  task,
  notes,
  readOnly,
  save,
  onClose,
  onTrash,
  onOpenNote,
}: TaskPanelProps) {
  const [draft, setDraft] = useState<TaskFields | null>(null);
  const [loadError, setLoadError] = useState<CommandError | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "saved" });
  const notify = useNotify();
  const latest = useRef<TaskFields | null>(null);
  const stored = useRef<TaskFields | null>(null);
  const timer = useRef<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Whoever opens a task, also by keyboard, lands in the panel.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    taskDetail(task).then(
      (detail) => {
        if (current) {
          const fields: TaskFields = {
            title: detail.task.title,
            description: detail.description,
            priority: detail.task.priority,
            due: detail.task.due,
            tags: detail.task.tags,
            notes: detail.task.notes,
          };
          latest.current = fields;
          stored.current = fields;
          setDraft(fields);
        }
      },
      (reason: unknown) => {
        if (current) {
          setLoadError(errorOf(reason));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [task]);

  /** Saves what is in the fields; `false` when it could not be saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const fields = latest.current;
    if (fields === null || same(fields, stored.current)) {
      return true;
    }
    if (fields.title.trim() === "") {
      setStatus({ kind: "noTitle" });
      return false;
    }
    setStatus({ kind: "saving" });
    const error = await save(task, fields);
    if (error !== null) {
      setStatus({ kind: "failed", error });
      return false;
    }
    stored.current = fields;
    if (same(latest.current, fields)) {
      setStatus({ kind: "saved" });
    }
    return true;
  }, [save, task]);

  // Leaving by another card or page: what is typed is still saved.
  const leaving = useRef(flush);
  useEffect(() => {
    leaving.current = flush;
  }, [flush]);
  useEffect(
    () => () => {
      void leaving.current().then((saved) => {
        if (!saved) {
          notify({
            tone: "error",
            title: "A task was not saved",
            description: "Its last change could not be saved.",
          });
        }
      });
    },
    [notify],
  );

  const change = (patch: Partial<TaskFields>) => {
    if (latest.current === null) {
      return;
    }
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setDraft(next);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      void flush();
    }, SAVE_DELAY_MS);
  };

  const close = () => {
    void flush().then((saved) => {
      if (saved) {
        onClose();
      }
    });
  };

  return (
    <section
      className={styles.panel}
      aria-label="Task"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className={styles.header}>
        <h2 ref={heading} className={styles.heading} tabIndex={-1}>
          Task
        </h2>
        <IconButton icon={X} label="Close task" size="sm" onClick={close} />
      </header>
      {loadError !== null ? (
        <ErrorState
          title="The task could not be opened"
          description={commandErrorMessage(loadError)}
        />
      ) : draft === null ? (
        <LoadingState label="Opening task…" />
      ) : (
        <div className={styles.body}>
          <TextField
            label="Title"
            value={draft.title}
            disabled={readOnly}
            onValueChange={(title: string) => {
              change({ title });
            }}
          />
          <TextField
            label="Description"
            value={draft.description}
            disabled={readOnly}
            render={<textarea className={styles.description} rows={8} />}
            onValueChange={(description: string) => {
              change({ description });
            }}
          />
          <div className={styles.priority}>
            <RadioGroup
              label="Priority"
              value={draft.priority}
              options={PRIORITIES}
              disabled={readOnly}
              onChange={(priority) => {
                change({ priority });
              }}
            />
          </div>
          <TextField
            label="Due"
            type="date"
            value={draft.due ?? ""}
            disabled={readOnly}
            onValueChange={(due: string) => {
              change({ due: due === "" ? null : due });
            }}
          />
          <Tags
            tags={draft.tags}
            readOnly={readOnly}
            onChange={(tags) => {
              change({ tags });
            }}
          />
          <NoteLinks
            links={draft.notes}
            notes={notes}
            readOnly={readOnly}
            onChange={(links) => {
              change({ notes: links });
            }}
            onOpen={onOpenNote}
          />
          <p
            className={styles.status}
            role={status.kind === "failed" ? "alert" : "status"}
            data-failed={status.kind === "failed" ? "" : undefined}
          >
            {status.kind === "saved" && !readOnly && "Saved"}
            {status.kind === "saving" && "Saving…"}
            {status.kind === "noTitle" &&
              "A task needs a title. Nothing was saved."}
            {status.kind === "failed" &&
              `Not saved. ${commandErrorMessage(status.error)}`}
          </p>
          {!readOnly && (
            <Button
              className={styles.trash}
              variant="ghost"
              size="sm"
              onClick={() => {
                onTrash(task);
              }}
            >
              <Trash2 className={styles.mark} strokeWidth={1.5} aria-hidden />
              Move to trash
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function Tags({
  tags,
  readOnly,
  onChange,
}: {
  tags: string[];
  readOnly: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState("");

  const add = () => {
    const tag = text.trim().replace(/^#/, "");
    setText("");
    if (
      tag !== "" &&
      !tags.some((one) => one.toLowerCase() === tag.toLowerCase())
    ) {
      onChange([...tags, tag]);
    }
  };

  return (
    <div className={styles.group}>
      {tags.length > 0 && (
        <ul className={styles.chips} aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag} className={styles.chip}>
              #{tag}
              {!readOnly && (
                <IconButton
                  icon={X}
                  label={`Remove tag ${tag}`}
                  size="sm"
                  onClick={() => {
                    onChange(tags.filter((one) => one !== tag));
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <TextField
          label="Add tag"
          value={text}
          description="Press Enter to add."
          autoComplete="off"
          spellCheck={false}
          onValueChange={setText}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
        />
      )}
    </div>
  );
}

function NoteLinks({
  links,
  notes,
  readOnly,
  onChange,
  onOpen,
}: {
  links: string[];
  notes: readonly string[];
  readOnly: boolean;
  onChange: (links: string[]) => void;
  onOpen: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const wanted = text.trim().toLowerCase();
  const found =
    wanted === ""
      ? []
      : notes
          .filter(
            (note) =>
              note.toLowerCase().includes(wanted) && !links.includes(note),
          )
          .slice(0, SUGGESTIONS);

  const add = (note: string) => {
    setText("");
    onChange([...links, note]);
  };

  return (
    <div className={styles.group}>
      {links.length > 0 && (
        <ul className={styles.links} aria-label="Linked notes">
          {links.map((link) => {
            const missing = !notes.includes(link);
            return (
              <li key={link} className={styles.link}>
                {missing ? (
                  <span className={styles.missing}>
                    {link} <em>Note is missing</em>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      onOpen(link);
                    }}
                  >
                    <FileText
                      className={styles.mark}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                    {link}
                  </button>
                )}
                {!readOnly && (
                  <IconButton
                    icon={X}
                    label={`Remove link to ${link}`}
                    size="sm"
                    onClick={() => {
                      onChange(links.filter((one) => one !== link));
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <>
          <TextField
            label="Link a note"
            value={text}
            autoComplete="off"
            spellCheck={false}
            onValueChange={setText}
            onKeyDown={(event) => {
              if (event.key === "Enter" && found.length > 0) {
                event.preventDefault();
                add(found[0]);
              }
            }}
          />
          {found.length > 0 && (
            <ul className={styles.links} aria-label="Matching notes">
              {found.map((note) => (
                <li key={note}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      add(note);
                    }}
                  >
                    {note}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
