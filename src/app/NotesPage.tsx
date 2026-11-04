import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  listNotes,
  type NotesView,
  type SkippedNotes,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import { NotePane } from "./notes/NotePane";
import { NoteTree, type TreeChange } from "./notes/NoteTree";
import { buildTree } from "./notes/tree";
import styles from "./NotesPage.module.css";

/** The tree shows at most this many notes; the rest are counted below it. */
export const SHOWN_NOTES = 1000;

type Loaded =
  | { status: "loading" }
  | { status: "ready"; view: NotesView }
  | { status: "failed"; error: CommandError };

const count = new Intl.NumberFormat("en");

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

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

const NOTES = "/notes";

/** The page address of a note: `/notes/` and its path, each part encoded. */
export function noteHref(path: string): string {
  return `${NOTES}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The note a page address names, or `null` for the list alone. */
export function notePathOf(location: string): string | null {
  if (!location.startsWith(`${NOTES}/`)) {
    return null;
  }
  try {
    const path = location
      .slice(NOTES.length + 1)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

// The notes of the open project (M3-002): how many, the folder tree on the left
// (M3-004), and the open note on the right (M3-003, owner decision Q4).
export function NotesPage() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  /** Counts reloads; the tree asks for one after every change. */
  const [version, setVersion] = useState(0);

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
  }, [version]);

  return (
    <div className={styles.page}>
      <PageHeader title="Notes" />
      <Content
        loaded={loaded}
        reload={() => {
          setVersion((last) => last + 1);
        }}
      />
    </div>
  );
}

function Content({ loaded, reload }: { loaded: Loaded; reload: () => void }) {
  const [location, navigate] = useLocation();
  const openPath = notePathOf(location);

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

  const shown = view.notes.slice(0, SHOWN_NOTES);
  const hidden = view.notes.length - shown.length;

  const changed = (change: TreeChange) => {
    reload();
    if (change.open !== undefined) {
      navigate(noteHref(change.open));
    } else if (change.moved !== undefined && openPath !== null) {
      const { from, to } = change.moved;
      navigate(noteHref(to + openPath.slice(from.length)), { replace: true });
    } else if (change.trashed !== undefined) {
      navigate(NOTES, { replace: true });
    }
  };

  return (
    <div className={styles.split}>
      <div className={styles.list}>
        <p className={styles.summary}>
          {view.notes.length === 0
            ? "No notes yet"
            : plural(view.notes.length, "note", "notes")}
        </p>
        <Notices notices={notices} />
        <NoteTree
          top={buildTree(shown, view.emptyFolders)}
          openPath={openPath}
          noteHref={noteHref}
          onChanged={changed}
        />
        {view.notes.length === 0 && (
          <p className={styles.more}>
            Liurium looks for .md and .markdown files, except in folders such as
            node_modules, target, or ones whose name starts with a dot.
          </p>
        )}
        {hidden > 0 && (
          <p className={styles.more}>
            {`And ${plural(hidden, "more note", "more notes")} not shown here.`}
          </p>
        )}
      </div>
      <div className={styles.open}>
        {openPath === null ? (
          <p className={styles.hint}>Choose a note on the left to open it.</p>
        ) : (
          <NotePane
            key={openPath}
            path={openPath}
            onMoved={(path) => {
              reload();
              navigate(noteHref(path), { replace: true });
            }}
          />
        )}
      </div>
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
