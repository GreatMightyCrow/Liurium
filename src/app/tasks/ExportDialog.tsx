import { type RefObject, useState } from "react";
import {
  exportTasks,
  exportTasksElsewhere,
  type TaskExport,
} from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { Button } from "../../ui/Button";
import { Dialog, DialogClose } from "../../ui/Dialog";
import { useNotify } from "../../ui/Notifications";
import { commandErrorMessage } from "../commandErrorMessage";
import styles from "./ExportDialog.module.css";

const FILE_NAME = "Tasks export.md";

interface ExportDialogProps {
  readOnly: boolean;
  /** Runs after the changes asked for before it, so the file holds them. */
  afterChanges: <T>(work: () => Promise<T>) => Promise<T>;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function messageOf(error: CommandError): string {
  // Only the save dialog can bring a name that is no Markdown file.
  return error.kind === "invalidPath"
    ? "Tasks can only be exported to a Markdown file ending in .md."
    : commandErrorMessage(error);
}

// Asks in Liurium's own design; the Windows dialog opens only for another place
// (M4-009). Rust picks the path in both cases, the page never names one.
export function ExportDialog({
  readOnly,
  afterChanges,
  finalFocus,
  onClose,
}: ExportDialogProps) {
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const notify = useNotify();

  const start = (work: () => Promise<TaskExport>) => {
    setBusy(true);
    setProblem(null);
    void afterChanges(work).then(
      (result) => {
        setBusy(false);
        if (result.state === "written") {
          notify({
            tone: "success",
            title: "Tasks exported",
            description: result.place,
          });
          onClose();
        } else if (result.state === "exists") {
          setExists(true);
        }
      },
      (reason: unknown) => {
        setBusy(false);
        setProblem(
          messageOf(
            reason instanceof CommandFailure
              ? reason.error
              : { kind: "internal" },
          ),
        );
      },
    );
  };

  const elsewhere = (
    <Button
      disabled={busy}
      onClick={() => {
        start(exportTasksElsewhere);
      }}
    >
      {readOnly ? "Choose a place…" : "Other place…"}
    </Button>
  );

  return (
    <Dialog
      title={exists ? `Replace “${FILE_NAME}”?` : "Export tasks"}
      description={
        exists
          ? "A different file with this name is already in the project. The old one goes to the project's trash."
          : "All tasks on the board go into one Markdown file, without the trash. It is a copy: changes in the file do not change the tasks."
      }
      open
      finalFocus={finalFocus}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>{exists ? "Keep it" : "Cancel"}</DialogClose>
          {elsewhere}
          {!readOnly && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                start(() => exportTasks(exists));
              }}
            >
              {exists ? "Replace" : "Save in project"}
            </Button>
          )}
        </>
      }
    >
      {!exists && (
        <p className={styles.place}>
          {readOnly
            ? "This project is write-protected, so the file has to go somewhere else."
            : `In the project: ${FILE_NAME}`}
        </p>
      )}
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
