import { FolderOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  listNotes,
  type NotesView,
  openProject,
  type SkippedNotes,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { Tabs } from "../ui/Tabs";
import { IconButton } from "../ui/IconButton";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import { useLayoutChoice } from "./layoutChoice";
import { NotePane } from "./notes/NotePane";
import { NoteTree, type TreeChange } from "./notes/NoteTree";
import { SearchPanel } from "./notes/SearchPanel";
import { useSearchRequest } from "./notes/searchRequest";
import { TagFilterBar, TagList, TagsFailed } from "./notes/TagList";
import { sameTag, useProjectTags } from "./notes/tags";
import { useNoteChanges } from "./notes/useNoteChanges";
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
  /** Counts changes outside Liurium (M3-008); the open note looks at its file. */
  const [outside, setOutside] = useState(0);
  useNoteChanges(() => {
    setVersion((last) => last + 1);
    setOutside((last) => last + 1);
  });

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
        version={version}
        outside={outside}
        reload={() => {
          setVersion((last) => last + 1);
        }}
      />
    </div>
  );
}

type ListTab = "files" | "tags" | "search";

const LIST_TABS: readonly { value: ListTab; label: string }[] = [
  { value: "files", label: "Files" },
  { value: "tags", label: "Tags" },
  { value: "search", label: "Search" },
];

function Content({
  loaded,
  version,
  outside,
  reload,
}: {
  loaded: Loaded;
  version: number;
  outside: number;
  reload: () => void;
}) {
  const [location, navigate] = useLocation();
  const [listTab, setListTab] = useState<ListTab>("files");
  /** The tag the tree is filtered by (M3-007). */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const tags = useProjectTags(
    listTab === "tags" || tagFilter !== null,
    `${String(version)}|${listTab}|${tagFilter ?? ""}`,
  );
  /** The note list can be hidden for a wider note (M3-014), remembered. */
  const [listHidden, setListHidden] = useLayoutChoice(
    "liurium.notes.listHidden",
    false,
  );
  const openPath = notePathOf(location);
  /** Kept while other tabs show, so coming back shows the same search (M4-002). */
  const [query, setQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(0);
  /** The place a search result opens a note at. */
  const [reveal, setReveal] = useState<{
    path: string;
    at: { offset: number };
  } | null>(null);
  const forgetReveal = useCallback(() => {
    setReveal(null);
  }, []);
  useSearchRequest(() => {
    setListTab("search");
    setListHidden(false);
    setSearchFocus((last) => last + 1);
  });

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

  const tagged =
    tagFilter === null
      ? null
      : new Set(
          tags.status === "ready"
            ? tags.rows.find((row) => sameTag(row.tag, tagFilter))?.notes
            : [],
        );
  const listed =
    tagged === null
      ? view.notes
      : view.notes.filter((note) => tagged.has(note.path));
  const shown = listed.slice(0, SHOWN_NOTES);
  const hidden = listed.length - shown.length;

  const chooseTag = (tag: string) => {
    setTagFilter(tag);
    setListTab("files");
    setListHidden(false);
  };

  const showList = listHidden ? (
    <IconButton
      label="Show note list"
      icon={PanelLeftOpen}
      size="sm"
      onClick={() => {
        setListHidden(false);
      }}
    />
  ) : null;

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
      {!listHidden && (
        <div className={styles.list}>
          <div className={styles.listHead}>
            <p className={styles.summary}>
              {view.notes.length === 0
                ? "No notes yet"
                : tagged === null
                  ? plural(view.notes.length, "note", "notes")
                  : `${count.format(listed.length)} of ${plural(view.notes.length, "note", "notes")}`}
            </p>
            <IconButton
              label="Hide note list"
              icon={PanelLeftClose}
              size="sm"
              onClick={() => {
                setListHidden(true);
              }}
            />
          </div>
          <Notices notices={notices} />
          <Tabs
            label="Note list"
            value={listTab}
            options={LIST_TABS}
            onChange={setListTab}
          >
            {listTab === "search" ? (
              <SearchPanel
                query={query}
                onQuery={setQuery}
                focusKey={searchFocus}
                refresh={version}
                onOpen={(path, offset) => {
                  setReveal(offset === null ? null : { path, at: { offset } });
                  navigate(noteHref(path));
                }}
                onOpenProject={(id) => {
                  openProject(id).then(
                    () => {
                      reload();
                      navigate(NOTES);
                    },
                    () => {
                      // The Projects page says why it cannot open.
                      navigate("/projects");
                    },
                  );
                }}
              />
            ) : listTab === "tags" ? (
              <TagList state={tags} chosen={tagFilter} onChoose={chooseTag} />
            ) : (
              <>
                {tagFilter !== null && (
                  <TagFilterBar
                    tag={tagFilter}
                    onClear={() => {
                      setTagFilter(null);
                    }}
                  />
                )}
                {tagFilter !== null && tags.status === "failed" && (
                  <TagsFailed state={tags} />
                )}
                <NoteTree
                  top={buildTree(
                    tagged === null ? shown : view.notes,
                    view.emptyFolders,
                  )}
                  only={
                    tagFilter === null
                      ? null
                      : {
                          key: tagFilter.toLowerCase(),
                          notes: new Set(shown.map((note) => note.path)),
                        }
                  }
                  openPath={openPath}
                  noteHref={noteHref}
                  onChanged={changed}
                />
                {tagFilter !== null &&
                  tags.status === "ready" &&
                  listed.length === 0 && (
                    <p className={styles.more}>No notes carry this tag.</p>
                  )}
                {view.notes.length === 0 && (
                  <p className={styles.more}>
                    Liurium looks for .md and .markdown files, except in folders
                    such as node_modules, target, or ones whose name starts with
                    a dot.
                  </p>
                )}
                {hidden > 0 && (
                  <p className={styles.more}>
                    {`And ${plural(hidden, "more note", "more notes")} not shown here.`}
                  </p>
                )}
              </>
            )}
          </Tabs>
        </div>
      )}
      <div className={styles.open}>
        {openPath === null ? (
          <div className={styles.hintRow}>
            {showList}
            <p className={styles.hint}>
              {listHidden
                ? "Show the note list to choose a note."
                : "Choose a note on the left to open it."}
            </p>
          </div>
        ) : (
          <NotePane
            key={openPath}
            path={openPath}
            onMoved={(path) => {
              reload();
              navigate(noteHref(path), { replace: true });
            }}
            notes={view.notes}
            onOpen={(path) => {
              navigate(noteHref(path));
            }}
            onCreated={reload}
            onTag={chooseTag}
            onClosed={() => {
              navigate(NOTES, { replace: true });
            }}
            outside={outside}
            leading={showList}
            reveal={reveal?.path === openPath ? reveal.at : null}
            onRevealed={forgetReveal}
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
