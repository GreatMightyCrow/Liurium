import { FileText, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  listNotes,
  type NoteEntry,
  type NotesView,
  type SkippedNotes,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./NotesPage.module.css";

/** The list shows at most this many notes; the folder tree replaces it later. */
export const SHOWN_NOTES = 1000;

type Loaded =
  | { status: "loading" }
  | { status: "ready"; view: NotesView }
  | { status: "failed"; error: CommandError };

const count = new Intl.NumberFormat("en");

const changedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function plural(n: number, one: string, many: string): string {
  return `${count.format(n)} ${n === 1 ? one : many}`;
}

/** One plain sentence about what the walk passed over, or `null` for nothing. */
export function skippedText(skipped: SkippedNotes): string | null {
  const parts = [
    skipped.linksOutside > 0 &&
      `${plural(skipped.linksOutside, "link", "links")} leading outside the project`,
    skipped.brokenLinks > 0 &&
      `${plural(skipped.brokenLinks, "link", "links")} leading nowhere`,
    skipped.badNames > 0 &&
      `${plural(skipped.badNames, "name", "names")} that Windows does not allow`,
    skipped.unreadable > 0 &&
      `${plural(skipped.unreadable, "item", "items")} Liurium could not read`,
    skipped.tooDeep > 0 &&
      `${plural(skipped.tooDeep, "folder", "folders")} nested deeper than ${count.format(skipped.depthLimit)} levels`,
  ].filter((part): part is string => part !== false);
  return parts.length === 0 ? null : `Not included: ${parts.join(", ")}.`;
}

interface Folder {
  /** Below the project folder; empty for notes at the top. */
  path: string;
  notes: { name: string; note: NoteEntry }[];
}

/** Notes at the top first, then folders by path without case. */
export function byFolder(notes: NoteEntry[]): Folder[] {
  const folders = new Map<string, Folder>();
  for (const note of notes) {
    const cut = note.path.lastIndexOf("/");
    const path = cut < 0 ? "" : note.path.slice(0, cut);
    const name = note.path.slice(cut + 1);
    let folder = folders.get(path);
    if (folder === undefined) {
      folder = { path, notes: [] };
      folders.set(path, folder);
    }
    folder.notes.push({ name, note });
  }
  return [...folders.values()].sort((a, b) =>
    a.path === "" || b.path === ""
      ? Number(a.path !== "") - Number(b.path !== "")
      : a.path.localeCompare(b.path, "en", { sensitivity: "base" }),
  );
}

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

// The notes Liurium found in the open project (M3-002): how many, and a plain
// list by folder. Opening a note comes with the editor.
export function NotesPage() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let current = true;
    listNotes().then(
      (view) => {
        if (current) {
          setLoaded({ status: "ready", view });
        }
      },
      (reason: unknown) => {
        if (current) {
          setLoaded({ status: "failed", error: errorOf(reason) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <PageHeader title="Notes" />
      <Content loaded={loaded} />
    </>
  );
}

function Content({ loaded }: { loaded: Loaded }) {
  const [, navigate] = useLocation();

  if (loaded.status === "loading") {
    return <LoadingState label="Looking for notes…" />;
  }
  if (loaded.status === "failed") {
    return (
      <ErrorState
        title="Notes could not be listed"
        description={commandErrorMessage(loaded.error)}
      />
    );
  }
  const { view } = loaded;
  if (view.state === "noProject") {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No project is open"
        description="Open a project to see its notes."
        action={
          <Button
            onClick={() => {
              navigate("/projects");
            }}
          >
            Go to Projects
          </Button>
        }
      />
    );
  }

  const skipped = skippedText(view.skipped);
  const notices = [
    view.truncated &&
      `This project holds more than ${count.format(view.noteLimit)} notes. Liurium lists the first ${count.format(view.noteLimit)}.`,
    skipped,
  ].filter((notice): notice is string => typeof notice === "string");

  if (view.notes.length === 0) {
    return (
      <div className={styles.content}>
        <EmptyState
          icon={FileText}
          title="No notes in this project yet"
          description="Liurium looks for .md and .markdown files, except in folders such as node_modules, target, or ones whose name starts with a dot."
        />
        <Notices notices={notices} />
      </div>
    );
  }

  const shown = view.notes.slice(0, SHOWN_NOTES);
  const hidden = view.notes.length - shown.length;

  return (
    <div className={styles.content}>
      <p className={styles.summary}>
        {plural(view.notes.length, "note", "notes")}
      </p>
      <Notices notices={notices} />
      {byFolder(shown).map((folder) => (
        <section
          key={folder.path}
          className={styles.folder}
          aria-label={folder.path === "" ? "Project folder" : folder.path}
        >
          <h2
            className={folder.path === "" ? styles.topName : styles.folderName}
          >
            {folder.path === "" ? "Project folder" : folder.path}
          </h2>
          <ul className={styles.list}>
            {folder.notes.map(({ name, note }) => (
              <li key={note.path} className={styles.row}>
                <FileText
                  className={styles.icon}
                  strokeWidth={1.5}
                  aria-hidden
                />
                <span className={styles.name}>{name}</span>
                <time
                  className={styles.when}
                  dateTime={new Date(note.modifiedMs).toISOString()}
                >
                  {changedAt.format(note.modifiedMs)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hidden > 0 && (
        <p className={styles.more}>
          {`And ${plural(hidden, "more note", "more notes")} not shown here.`}
        </p>
      )}
    </div>
  );
}

function Notices({ notices }: { notices: string[] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className={styles.notices} role="status">
      {notices.map((notice) => (
        <p key={notice} className={styles.notice}>
          {notice}
        </p>
      ))}
    </div>
  );
}
