import { useEffect, useState } from "react";
import {
  answerCloseQuestion,
  type CloseChoice,
  type CloseQuestion,
  type CloseReason,
  waitCloseQuestion,
} from "../lib/ipc/commands";
import { Button } from "../ui/Button";
import { Dialog, DialogClose } from "../ui/Dialog";
import { flushOpenNote } from "./notes/useOpenNote";

/** After a failed wait, for example while the app data folder is unusable. */
const RETRY_AFTER_MS = 5000;

const reasonText: Record<CloseReason, string> = {
  changedOutside: "It was changed outside Liurium since you opened it.",
  deletedOutside: "The file was deleted or moved outside Liurium.",
  notWritten: "Liurium could not write the file.",
};

// The question when the window closes and a note could not be saved (M3-016). It
// lives in the shell because a draft can wait while another page is open. Rust stops
// the close and waits for the answer; every way of closing ends up here.
export function CloseQuestionDialog() {
  const [question, setQuestion] = useState<CloseQuestion | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    let retry: number | null = null;
    const wait = () => {
      waitCloseQuestion().then(
        (next) => {
          if (current) {
            if (next !== null) {
              setQuestion(next);
            }
            wait();
          }
        },
        () => {
          if (current) {
            retry = window.setTimeout(wait, RETRY_AFTER_MS);
          }
        },
      );
    };
    wait();
    return () => {
      current = false;
      if (retry !== null) {
        window.clearTimeout(retry);
      }
    };
  }, []);

  // Tells Rust the page is alive and shows it; each close asks anew. Without this,
  // Rust keeps the text as a copy and closes after a few seconds.
  useEffect(() => {
    if (question !== null) {
      answerCloseQuestion("shown").catch(() => {
        // Rust then treats the page as not answering, which loses nothing.
      });
    }
  }, [question]);

  const answer = (choice: CloseChoice) => {
    setBusy(true);
    // Typing from the last moments reaches Rust before it makes the copy.
    const ready = choice === "keepBoth" ? flushOpenNote() : Promise.resolve();
    ready
      .catch(() => {
        // The note shows its own save failure; Rust holds the last text it got.
      })
      .then(() => answerCloseQuestion(choice))
      .then(
        (outcome) => {
          // "closes": the window goes away by itself.
          if (outcome === "copyFailed") {
            setQuestion(null);
            setCopyFailed(true);
          } else if (outcome === "stays") {
            setQuestion(null);
          }
        },
        () => {
          // Nothing happened; the question stays open to try again.
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  if (copyFailed) {
    return (
      <Dialog
        open
        onOpenChange={setCopyFailed}
        title="Not saved"
        description="Liurium could not save a copy either. It stays open so nothing is lost."
        actions={<DialogClose variant="primary">OK</DialogClose>}
      />
    );
  }
  if (question === null) {
    return null;
  }
  const deleted = question.reason === "deletedOutside";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          answer("stay");
        }
      }}
      title="Unsaved changes"
      description={`Your changes to “${question.name}” are not saved. ${reasonText[question.reason]} ${
        deleted
          ? "Keeping a copy saves your text as a new note in its folder."
          : "Keeping both saves your version as a separate note next to it."
      }`}
      actions={
        <>
          <DialogClose disabled={busy}>Cancel</DialogClose>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              answer("discard");
            }}
          >
            Discard and close
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              answer("keepBoth");
            }}
          >
            {deleted ? "Keep copy and close" : "Keep both and close"}
          </Button>
        </>
      }
    />
  );
}
