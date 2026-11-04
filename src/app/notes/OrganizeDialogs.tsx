import { type SubmitEvent, useId, useState } from "react";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { Button } from "../../ui/Button";
import { Dialog, DialogClose } from "../../ui/Dialog";
import { RadioGroup } from "../../ui/RadioGroup";
import { TextField } from "../../ui/TextField";
import { commandErrorMessage } from "../commandErrorMessage";
import styles from "./NoteTree.module.css";
import { isInside, nameOf, parentOf } from "./tree";

/** What the tree asks the user about (M3-004). */
export type Asking =
  | { kind: "newNote"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string; isFolder: boolean }
  | { kind: "move"; path: string; isFolder: boolean }
  | { kind: "delete"; path: string; isFolder: boolean; notes: number };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

/** Runs an action; keeps the dialog open with the reason when it fails. */
function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().then(
      () => {
        setBusy(false);
        onDone();
      },
      (reason: unknown) => {
        setBusy(false);
        setError(commandErrorMessage(errorOf(reason)));
      },
    );
  };
  return { busy, error, run };
}

const folderLabel = (folder: string) =>
  folder === "" ? "the project folder" : `“${folder}”`;

interface NameDialogProps {
  asking: Extract<Asking, { kind: "newNote" | "newFolder" | "rename" }>;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}

export function NameDialog({ asking, onSubmit, onClose }: NameDialogProps) {
  const formId = useId();
  const current =
    asking.kind === "rename"
      ? asking.isFolder
        ? nameOf(asking.path)
        : nameOf(asking.path).replace(/\.(md|markdown)$/i, "")
      : "";
  const [name, setName] = useState(current);
  const { busy, error, run } = useAction(onClose);
  const copy = {
    newNote: {
      title: "New note",
      description: `A new note in ${folderLabel(asking.kind === "rename" ? "" : asking.folder)}. Liurium adds .md to the name.`,
      action: "Create note",
    },
    newFolder: {
      title: "New folder",
      description: `A new folder in ${folderLabel(asking.kind === "rename" ? "" : asking.folder)}.`,
      action: "Create folder",
    },
    rename: {
      title: `Rename “${asking.kind === "rename" ? nameOf(asking.path) : ""}”`,
      description:
        "Links in other notes are not updated yet; that comes with link support.",
      action: "Rename",
    },
  }[asking.kind];

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => onSubmit(name));
  };

  return (
    <Dialog
      open
      title={copy.title}
      description={copy.description}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={busy || name.trim() === ""}
          >
            {copy.action}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <TextField
          label="Name"
          value={name}
          error={error}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}

interface MoveDialogProps {
  asking: Extract<Asking, { kind: "move" }>;
  folders: readonly string[];
  onSubmit: (folder: string) => Promise<unknown>;
  onClose: () => void;
}

export function MoveDialog({
  asking,
  folders,
  onSubmit,
  onClose,
}: MoveDialogProps) {
  const from = parentOf(asking.path);
  const [target, setTarget] = useState(from);
  const { busy, error, run } = useAction(onClose);
  // A folder cannot move into itself or anything inside it.
  const options = folders
    .filter((folder) => !(asking.isFolder && isInside(folder, asking.path)))
    .map((folder) => ({
      value: folder,
      label: folder === "" ? "Project folder (top)" : folder,
    }));

  return (
    <Dialog
      open
      title={`Move “${nameOf(asking.path)}”`}
      description="Choose the folder it moves into. Links in other notes are not updated yet."
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
            disabled={busy || target.toLowerCase() === from.toLowerCase()}
            onClick={() => {
              run(() => onSubmit(target));
            }}
          >
            Move here
          </Button>
        </>
      }
    >
      <div className={styles.moveList}>
        <RadioGroup
          label="Folder"
          value={target}
          options={options}
          onChange={setTarget}
        />
      </div>
      {error !== undefined && (
        <p className={styles.dialogError} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

interface DeleteDialogProps {
  asking: Extract<Asking, { kind: "delete" }>;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}

export function DeleteDialog({
  asking,
  onConfirm,
  onClose,
}: DeleteDialogProps) {
  const { busy, error, run } = useAction(onClose);
  const name = nameOf(asking.path);
  const what = asking.isFolder
    ? `The folder and everything in it${asking.notes > 0 ? ` (${String(asking.notes)} ${asking.notes === 1 ? "note" : "notes"})` : ""}`
    : "The note";
  return (
    <Dialog
      open
      title={`Delete “${name}”?`}
      description={`${what} moves to this project's trash, .liurium/trash. You can get it back from there.`}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              run(onConfirm);
            }}
          >
            Move to trash
          </Button>
        </>
      }
    >
      {error !== undefined && (
        <p className={styles.dialogError} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
