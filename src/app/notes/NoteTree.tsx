import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import {
  ChevronRight,
  Ellipsis,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { Link } from "wouter";
import {
  createFolder,
  createNote,
  moveEntry,
  renameEntry,
  trashEntry,
} from "../../lib/ipc/commands";
import { Button } from "../../ui/Button";
import { MenuItem, MenuSeparator } from "../../ui/Menu";
import { flushOpenNote } from "./useOpenNote";
import menuStyles from "../../ui/Menu.module.css";
import styles from "./NoteTree.module.css";
import {
  type Asking,
  DeleteDialog,
  MoveDialog,
  NameDialog,
} from "./OrganizeDialogs";
import {
  allFolders,
  ancestors,
  type FolderNode,
  isInside,
  type NoteNode,
  parentOf,
} from "./tree";

/** What changed, so the page can reload the tree and follow the open note. */
export interface TreeChange {
  /** Open this note now (a new note). */
  open?: string;
  /** The open note moved from one path to another (rename or move). */
  moved?: { from: string; to: string };
  /** Everything at or below this path went to the trash. */
  trashed?: string;
}

interface NoteTreeProps {
  top: FolderNode;
  openPath: string | null;
  noteHref: (path: string) => string;
  onChanged: (change: TreeChange) => void;
}

const DRAG_TYPE = "application/x-liurium-entry";

/** The open note's last text reaches Rust and is saved before anything moves, so a
 *  rename right after typing keeps what was typed (found by the M3-004 E2E test). */
function saveOpenNote(): Promise<void> {
  return flushOpenNote();
}

type Target = { kind: "folder"; path: string } | { kind: "note"; path: string };

// The notes tree (M3-004): folders that hold notes plus empty ones; a bar with
// New note and New folder; a "…" menu on every row and the same menu on a right
// click; drag and drop onto folders. Nested lists with disclosure buttons, not
// role=tree, because every row also has its own menu button; arrow keys still
// move between rows, F2 renames, Delete asks to move to the trash.
export function NoteTree({
  top,
  openPath,
  noteHref,
  onChanged,
}: NoteTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(openPath === null ? [] : ancestors(openPath)),
  );
  const [asking, setAsking] = useState<Asking | null>(null);
  const [menuTarget, setMenuTarget] = useState<Target>({
    kind: "folder",
    path: "",
  });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    target: Target;
    anchor: HTMLElement;
  } | null>(null);
  /** Focus returns here when the row menu closes. */
  const menuAnchor = useRef<HTMLElement | null>(null);
  const openRowMenu = (target: Target, anchor: HTMLElement) => {
    menuAnchor.current = anchor;
    setRowMenu({ target, anchor });
  };
  /** Where New note and New folder put things: the folder last chosen. */
  const [current, setCurrent] = useState<string>(
    openPath === null ? "" : parentOf(openPath),
  );

  const toggle = (path: string, open?: boolean) => {
    setExpanded((last) => {
      const next = new Set(last);
      if (open ?? !last.has(path)) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  const notesBelow = (path: string): number => {
    let count = 0;
    const walk = (folder: FolderNode) => {
      if (isInside(folder.path, path)) {
        count += folder.notes.length;
      }
      folder.folders.forEach(walk);
    };
    walk(top);
    return count;
  };

  const ask = (target: Target, kind: "rename" | "move" | "delete") => {
    const isFolder = target.kind === "folder";
    setAsking(
      kind === "delete"
        ? {
            kind,
            path: target.path,
            isFolder,
            notes: isFolder ? notesBelow(target.path) : 1,
          }
        : { kind, path: target.path, isFolder },
    );
  };

  const moved = (from: string, to: string) => {
    onChanged(
      openPath !== null && isInside(openPath, from)
        ? { moved: { from, to } }
        : {},
    );
  };

  const move = (path: string, folder: string) =>
    saveOpenNote()
      .then(() => moveEntry(path, folder))
      .then((to) => {
        if (folder !== "") {
          toggle(folder, true);
        }
        moved(path, to);
      });

  const items = (target: Target) =>
    target.kind === "note" || target.path !== "" ? (
      <>
        {target.kind === "folder" && (
          <>
            <MenuItem
              onSelect={() => {
                setAsking({ kind: "newNote", folder: target.path });
              }}
            >
              New note here…
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setAsking({ kind: "newFolder", folder: target.path });
              }}
            >
              New folder here…
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem
          onSelect={() => {
            ask(target, "rename");
          }}
        >
          Rename…
        </MenuItem>
        <MenuItem
          onSelect={() => {
            ask(target, "move");
          }}
        >
          Move to…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            ask(target, "delete");
          }}
        >
          Delete…
        </MenuItem>
      </>
    ) : (
      <>
        <MenuItem
          onSelect={() => {
            setAsking({ kind: "newNote", folder: "" });
          }}
        >
          New note…
        </MenuItem>
        <MenuItem
          onSelect={() => {
            setAsking({ kind: "newFolder", folder: "" });
          }}
        >
          New folder…
        </MenuItem>
      </>
    );

  const targetOf = (element: EventTarget | null): Target => {
    const row =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-path]")
        : null;
    const path = row?.dataset.path;
    if (row === null || path === undefined) {
      return { kind: "folder", path: "" };
    }
    return { kind: row.dataset.kind === "note" ? "note" : "folder", path };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]"),
    ];
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index < 0) {
      return;
    }
    const row = rows[index];
    const target = targetOf(row);
    const focus = (next: HTMLElement | undefined) => {
      event.preventDefault();
      next?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        focus(rows[index + 1]);
        break;
      case "ArrowUp":
        focus(rows[index - 1]);
        break;
      case "Home":
        focus(rows[0]);
        break;
      case "End":
        focus(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (target.kind === "folder") {
          event.preventDefault();
          if (expanded.has(target.path)) {
            rows[index + 1]?.focus();
          } else {
            toggle(target.path, true);
          }
        }
        break;
      case "ArrowLeft":
        if (target.kind === "folder" && expanded.has(target.path)) {
          event.preventDefault();
          toggle(target.path, false);
        } else {
          const parent = parentOf(target.path);
          focus(
            rows.find(
              (candidate) =>
                parent !== "" &&
                candidate.closest<HTMLElement>("[data-path]")?.dataset.path ===
                  parent,
            ),
          );
        }
        break;
      case "F2":
        event.preventDefault();
        ask(target, "rename");
        break;
      case "Delete":
        event.preventDefault();
        ask(target, "delete");
        break;
      default:
    }
  };

  const dragOver = (folder: string) => (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(folder);
  };

  const drop = (folder: string) => (event: DragEvent<HTMLElement>) => {
    const path = event.dataTransfer.getData(DRAG_TYPE);
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (path === "" || parentOf(path).toLowerCase() === folder.toLowerCase()) {
      return;
    }
    if (isInside(folder, path)) {
      return;
    }
    move(path, folder).catch(() => {
      // The "Move to…" dialog explains failures; a failed drop changes nothing.
      onChanged({});
    });
  };

  const dragStart = (path: string) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(DRAG_TYPE, path);
    event.dataTransfer.effectAllowed = "move";
  };

  const renderFolder = (folder: FolderNode): ReactNode => (
    <ul className={styles.group} role="list">
      {folder.folders.map((child) => {
        const open = expanded.has(child.path);
        return (
          <li
            key={child.path}
            data-path={child.path}
            data-kind="folder"
            className={styles.item}
          >
            <div
              className={styles.row}
              data-drop={dropTarget === child.path ? "" : undefined}
              onDragOver={dragOver(child.path)}
              onDragLeave={() => {
                setDropTarget(null);
              }}
              onDrop={drop(child.path)}
            >
              <button
                type="button"
                className={styles.entry}
                aria-expanded={open}
                data-row
                draggable
                onDragStart={dragStart(child.path)}
                onClick={() => {
                  toggle(child.path);
                  setCurrent(child.path);
                }}
              >
                <ChevronRight
                  className={styles.chevron}
                  data-open={open ? "" : undefined}
                  strokeWidth={1.5}
                  aria-hidden
                />
                <Folder className={styles.icon} strokeWidth={1.5} aria-hidden />
                <span className={styles.name}>{child.name}</span>
              </button>
              <MoreButton
                label={`Actions for ${child.name}`}
                open={
                  rowMenu?.target.kind === "folder" &&
                  rowMenu.target.path === child.path
                }
                onOpen={(anchor) => {
                  openRowMenu({ kind: "folder", path: child.path }, anchor);
                }}
              />
            </div>
            {open && renderFolder(child)}
          </li>
        );
      })}
      {folder.notes.map((note) => (
        <NoteRow
          key={note.path}
          note={note}
          href={noteHref(note.path)}
          isOpen={openPath?.toLowerCase() === note.path.toLowerCase()}
          onDragStart={dragStart(note.path)}
          onDragOver={dragOver(parentOf(note.path))}
          onDrop={drop(parentOf(note.path))}
          onChoose={() => {
            setCurrent(parentOf(note.path));
          }}
          menuOpen={
            rowMenu?.target.kind === "note" && rowMenu.target.path === note.path
          }
          onMenu={(anchor) => {
            openRowMenu({ kind: "note", path: note.path }, anchor);
          }}
        />
      ))}
    </ul>
  );

  return (
    <div className={styles.tree}>
      <div className={styles.bar}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setAsking({ kind: "newNote", folder: current });
          }}
        >
          <FilePlus className={styles.icon} strokeWidth={1.5} aria-hidden />
          New note
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setAsking({ kind: "newFolder", folder: current });
          }}
        >
          <FolderPlus className={styles.icon} strokeWidth={1.5} aria-hidden />
          New folder
        </Button>
      </div>
      {/* One menu for every "…" button, placed at the button that opened it: a
          menu per row made a long tree slow (CI timed out at 1000 notes). */}
      <BaseMenu.Root
        open={rowMenu !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRowMenu(null);
          }
        }}
      >
        <BaseMenu.Portal>
          <BaseMenu.Positioner
            className={menuStyles.positioner}
            anchor={rowMenu?.anchor}
            align="start"
          >
            <BaseMenu.Popup className={menuStyles.menu} finalFocus={menuAnchor}>
              {rowMenu !== null && items(rowMenu.target)}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <nav
              className={styles.list}
              aria-label="Notes in this project"
              data-drop={dropTarget === "" ? "" : undefined}
              onKeyDown={onKeyDown}
              onContextMenuCapture={(event: MouseEvent) => {
                setMenuTarget(targetOf(event.target));
              }}
              onDragOver={dragOver("")}
              onDragLeave={() => {
                setDropTarget(null);
              }}
              onDrop={drop("")}
            />
          }
        >
          {renderFolder(top)}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className={menuStyles.positioner}>
            <ContextMenu.Popup className={menuStyles.menu}>
              {items(menuTarget)}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {asking !== null &&
        (asking.kind === "newNote" ||
          asking.kind === "newFolder" ||
          asking.kind === "rename") && (
          <NameDialog
            key={asking.kind}
            asking={asking}
            onClose={() => {
              setAsking(null);
            }}
            onSubmit={(name) => {
              if (asking.kind === "newNote") {
                return createNote(asking.folder, name).then((path) => {
                  if (asking.folder !== "") {
                    toggle(asking.folder, true);
                  }
                  onChanged({ open: path });
                });
              }
              if (asking.kind === "newFolder") {
                return createFolder(asking.folder, name).then((path) => {
                  if (asking.folder !== "") {
                    toggle(asking.folder, true);
                  }
                  setCurrent(path);
                  onChanged({});
                });
              }
              return saveOpenNote()
                .then(() => renameEntry(asking.path, name))
                .then((to) => {
                  moved(asking.path, to);
                });
            }}
          />
        )}
      {asking?.kind === "move" && (
        <MoveDialog
          asking={asking}
          folders={allFolders(top)}
          onClose={() => {
            setAsking(null);
          }}
          onSubmit={(folder) => move(asking.path, folder)}
        />
      )}
      {asking?.kind === "delete" && (
        <DeleteDialog
          asking={asking}
          onClose={() => {
            setAsking(null);
          }}
          onConfirm={() =>
            saveOpenNote()
              .then(() => trashEntry(asking.path))
              .then(() => {
                onChanged(
                  openPath !== null && isInside(openPath, asking.path)
                    ? { trashed: asking.path }
                    : {},
                );
              })
          }
        />
      )}
    </div>
  );
}

interface MoreButtonProps {
  label: string;
  open: boolean;
  onOpen: (anchor: HTMLElement) => void;
}

function MoreButton({ label, open, onOpen }: MoreButtonProps) {
  return (
    <button
      type="button"
      className={styles.more}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-popup-open={open ? "" : undefined}
      onClick={(event) => {
        onOpen(event.currentTarget);
      }}
    >
      <Ellipsis className={styles.icon} strokeWidth={1.5} aria-hidden />
    </button>
  );
}

interface NoteRowProps {
  note: NoteNode;
  href: string;
  isOpen: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onChoose: () => void;
  menuOpen: boolean;
  onMenu: (anchor: HTMLElement) => void;
}

function NoteRow({
  note,
  href,
  isOpen,
  onDragStart,
  onDragOver,
  onDrop,
  onChoose,
  menuOpen,
  onMenu,
}: NoteRowProps) {
  return (
    <li data-path={note.path} data-kind="note" className={styles.item}>
      <div className={styles.row} onDragOver={onDragOver} onDrop={onDrop}>
        <Link
          href={href}
          className={styles.entry}
          aria-current={isOpen ? "page" : undefined}
          data-row
          draggable
          onDragStart={onDragStart}
          onClick={onChoose}
        >
          <FileText className={styles.icon} strokeWidth={1.5} aria-hidden />
          <span className={styles.name}>{note.name}</span>
        </Link>
        <MoreButton
          label={`Actions for ${note.name}`}
          open={menuOpen}
          onOpen={onMenu}
        />
      </div>
    </li>
  );
}
