import { FileText } from "lucide-react";
import { Link, useLocation } from "wouter";
import { listNotes, type NoteEntry } from "../../lib/ipc/commands";
import { Button } from "../../ui/Button";
import { noteHref } from "../NotesPage";
import { nameOf, parentOf } from "../notes/tree";
import styles from "./Dashboard.module.css";
import { useWidgetData, WidgetContent } from "./widget";

/** The widget lists at most this many notes. */
export const RECENT_NOTES = 8;

/** The most recently changed notes first; the same time keeps path order. */
export function recentNotes(
  notes: readonly NoteEntry[],
  count = RECENT_NOTES,
): NoteEntry[] {
  return [...notes]
    .sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path))
    .slice(0, count);
}

const changedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// The open project's notes that changed last, each a link that opens the note.
// Times come from the files, so changes made outside Liurium count too.
export function RecentNotes() {
  const { data, reload } = useWidgetData(listNotes);
  const [, navigate] = useLocation();
  return (
    <WidgetContent
      data={data}
      loading="Loading notes…"
      failed="Notes could not be listed."
      onRetry={reload}
    >
      {(view) => {
        if (view.state === "noProject") {
          return (
            <div className={styles.empty}>
              <p className={styles.note}>
                No project is open. Open one to see its notes here.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  navigate("/projects");
                }}
              >
                Go to Projects
              </Button>
            </div>
          );
        }
        if (view.notes.length === 0) {
          return <p className={styles.note}>This project has no notes yet.</p>;
        }
        return (
          <ol className={styles.list}>
            {recentNotes(view.notes).map((note) => {
              const folder = parentOf(note.path);
              const changed = new Date(note.modifiedMs);
              return (
                <li key={note.path}>
                  <Link href={noteHref(note.path)} className={styles.entry}>
                    <FileText
                      className={styles.icon}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                    <span className={styles.name}>{nameOf(note.path)}</span>
                    <span className={styles.meta}>
                      {folder !== "" && <>{folder} · </>}
                      <time dateTime={changed.toISOString()}>
                        {changedAt.format(changed)}
                      </time>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        );
      }}
    </WidgetContent>
  );
}
