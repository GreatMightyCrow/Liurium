import { ListChecks, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  type Board,
  type BoardColumn,
  createColumn,
  createTask,
  deleteColumn,
  deleteTask,
  getCurrentProject,
  listNotes,
  moveColumn,
  moveTask,
  renameColumn,
  restoreTask,
  type Task,
  type TaskFields,
  taskBoard,
  trashedTasks,
  trashTask,
  updateTask,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { Dialog, DialogClose } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { TextField } from "../ui/TextField";
import { commandErrorMessage } from "./commandErrorMessage";
import { noteHref } from "./NotesPage";
import { movedTask, type Target, today } from "./tasks/board";
import {
  countTasks,
  filteredBoard,
  fits,
  isFiltering,
  lastTaskIn,
  rememberedFilter,
  rememberFilter,
  storedTarget,
  tagChoices,
  type TaskFilter,
} from "./tasks/filter";
import { focusCard, TaskBoard } from "./tasks/TaskBoard";
import { TaskFilterBar } from "./tasks/TaskFilterBar";
import { TaskPanel } from "./tasks/TaskPanel";
import { useDescriptionSearch } from "./tasks/useDescriptionSearch";
import panelStyles from "./tasks/TaskPanel.module.css";
import styles from "./TasksPage.module.css";

type Loaded =
  | { status: "loading" }
  | { status: "noProject" }
  | { status: "failed"; error: CommandError }
  | {
      status: "ready";
      board: Board;
      trash: Task[];
      notes: string[];
      readOnly: boolean;
      project: string;
      filter: TaskFilter;
    };

type Panel = { kind: "task"; task: string } | { kind: "trash" } | null;

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

async function loadPage(): Promise<Loaded> {
  try {
    const current = await getCurrentProject();
    if (current.state === "none") {
      return { status: "noProject" };
    }
    if (current.state === "unavailable") {
      return { status: "failed", error: current.error };
    }
    const [board, trash, view] = await Promise.all([
      taskBoard(),
      trashedTasks(),
      listNotes(),
    ]);
    return {
      status: "ready",
      board,
      trash,
      notes: view.state === "ready" ? view.notes.map((note) => note.path) : [],
      readOnly: current.project.readOnly,
      project: current.project.id,
      filter: rememberedFilter(current.project.id),
    };
  } catch (reason: unknown) {
    return { status: "failed", error: errorOf(reason) };
  }
}

// The open project's tasks as a board (M4-004). Rust holds the truth: every change
// goes there one after the other, and the board shows what it answers.
export function TasksPage() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [panel, setPanel] = useState<Panel>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<BoardColumn | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [addedHidden, setAddedHidden] = useState(false);
  const filterField = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const search = useDescriptionSearch(
    loaded.status === "ready" ? loaded.filter.text : "",
    loaded.status === "ready" ? loaded.board : null,
  );

  useEffect(() => {
    let current = true;
    void loadPage().then((next) => {
      if (current) {
        setLoaded(next);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const showBoard = useCallback((board: Board) => {
    setLoaded((last) => (last.status === "ready" ? { ...last, board } : last));
  }, []);

  const refreshTrash = useCallback(() => {
    void trashedTasks().then(
      (trash) => {
        setLoaded((last) =>
          last.status === "ready" ? { ...last, trash } : last,
        );
      },
      () => {
        // The trash shows its last state; the next change brings it up to date.
      },
    );
  }, []);

  /** Runs after everything asked before it; the answer becomes the board. */
  const run = useCallback(
    (action: () => Promise<Board | null>): Promise<CommandError | null> => {
      const result = queue.current.then(action).then(
        (board) => {
          if (board !== null) {
            showBoard(board);
          }
          return null;
        },
        (reason: unknown) => errorOf(reason),
      );
      queue.current = result;
      return result;
    },
    [showBoard],
  );

  /** As `run`, and a failure shows above the board. */
  const act = useCallback(
    (intro: string, action: () => Promise<Board | null>) =>
      run(action).then((error) => {
        setProblem(
          error === null ? null : `${intro} ${commandErrorMessage(error)}`,
        );
        return error;
      }),
    [run],
  );

  const save = useCallback(
    (task: string, fields: TaskFields) => run(() => updateTask(task, fields)),
    [run],
  );

  if (loaded.status === "loading") {
    return (
      <Page>
        <LoadingState label="Loading tasks…" />
      </Page>
    );
  }
  if (loaded.status === "noProject") {
    return (
      <Page>
        <EmptyState
          icon={ListChecks}
          title="No project is open"
          description="Tasks belong to a project. Open one to see its board."
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
      </Page>
    );
  }
  if (loaded.status === "failed") {
    return (
      <Page>
        <ErrorState
          title="The tasks could not be loaded"
          description={commandErrorMessage(loaded.error)}
        />
      </Page>
    );
  }

  const { board, trash, notes, readOnly, project, filter } = loaded;
  const filtering = isFiltering(filter);
  const day = today();
  const shown = filteredBoard(board, filter, search.ids, day);

  const setFilter = (next: TaskFilter) => {
    rememberFilter(project, next);
    setAddedHidden(false);
    setLoaded((last) =>
      last.status === "ready" ? { ...last, filter: next } : last,
    );
  };

  const onMove = (task: string, moved: Target) => {
    const target = storedTarget(board, shown, task, moved);
    if (target === null) {
      return;
    }
    showBoard(movedTask(board, task, target.column, target.index));
    void act("The task was not moved.", () =>
      moveTask(task, target.column, target.index),
    ).then((error) => {
      if (error !== null) {
        void loadPage().then(setLoaded);
      }
    });
  };

  const closePanel = () => {
    const open = panel;
    setPanel(null);
    if (open?.kind === "task" && !focusCard(open.task)) {
      filterField.current?.focus();
    }
  };

  const onTrash = (task: string) => {
    setPanel(null);
    void act("The task was not moved to the trash.", () =>
      trashTask(task),
    ).then(refreshTrash);
  };

  return (
    <Page>
      <div className={styles.toolbar}>
        <TaskFilterBar
          filter={filter}
          tags={tagChoices(board, filter.tags)}
          shown={countTasks(shown)}
          total={countTasks(board)}
          addedHidden={addedHidden}
          searchFailed={search.failed}
          field={filterField}
          onChange={setFilter}
        />
        {readOnly && (
          <p className={styles.notice}>
            This project is write-protected. Tasks can be read but not changed.
          </p>
        )}
        <Button
          className={styles.trashButton}
          variant="ghost"
          size="sm"
          aria-pressed={panel?.kind === "trash"}
          onClick={() => {
            setPanel(panel?.kind === "trash" ? null : { kind: "trash" });
          }}
        >
          <Trash2 className={styles.mark} strokeWidth={1.5} aria-hidden />
          Trash ({trash.length})
        </Button>
      </div>
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      <div className={styles.work}>
        <div className={styles.boardArea}>
          <TaskBoard
            board={shown}
            whole={board}
            readOnly={readOnly}
            selected={panel?.kind === "task" ? panel.task : null}
            onOpen={(task) => {
              setPanel({ kind: "task", task });
            }}
            onMove={onMove}
            onAddTask={(column, title) =>
              act("The task was not added.", () =>
                createTask(column, {
                  title,
                  description: "",
                  priority: "none",
                  due: null,
                  tags: [],
                  notes: [],
                }).then((next) => {
                  const added = lastTaskIn(next, column);
                  setAddedHidden(
                    filtering &&
                      added !== undefined &&
                      !fits(added, filter, search.ids, day),
                  );
                  return next;
                }),
              ).then((error) => {
                // The field beside the column says why.
                if (error !== null) {
                  setProblem(null);
                }
                return error;
              })
            }
            onAddColumn={(name) =>
              act("The column was not added.", () => createColumn(name)).then(
                (error) => {
                  if (error !== null) {
                    setProblem(null);
                  }
                  return error;
                },
              )
            }
            onRenameColumn={setRenaming}
            onMoveColumn={(column, index) => {
              void act("The column was not moved.", () =>
                moveColumn(column, index),
              );
            }}
            onDeleteColumn={(column) => {
              void act("The column was not deleted.", () =>
                deleteColumn(column),
              ).then(refreshTrash);
            }}
          />
        </div>
        {panel?.kind === "task" && (
          <TaskPanel
            key={panel.task}
            task={panel.task}
            notes={notes}
            readOnly={readOnly}
            save={save}
            onClose={closePanel}
            onTrash={onTrash}
            onOpenNote={(path) => {
              navigate(noteHref(path));
            }}
          />
        )}
        {panel?.kind === "trash" && (
          <section
            className={panelStyles.panel}
            aria-label="Trash"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closePanel();
              }
            }}
          >
            <header className={panelStyles.header}>
              <h2 className={panelStyles.heading}>Trash</h2>
              <IconButton
                icon={X}
                label="Close trash"
                size="sm"
                onClick={closePanel}
              />
            </header>
            <div className={panelStyles.body}>
              {trash.length === 0 ? (
                <p className={panelStyles.status}>The trash is empty.</p>
              ) : (
                <ul className={styles.trashList}>
                  {trash.map((task) => (
                    <li key={task.id} className={styles.trashRow}>
                      <span className={styles.trashTitle}>{task.title}</span>
                      {!readOnly && (
                        <span className={styles.trashActions}>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void act("The task was not restored.", () =>
                                restoreTask(task.id),
                              ).then(refreshTrash);
                            }}
                          >
                            <RotateCcw
                              className={styles.mark}
                              strokeWidth={1.5}
                              aria-hidden
                            />
                            Restore
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setDeleting(task);
                            }}
                          >
                            Delete for good…
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
      {renaming !== null && (
        <RenameColumn
          column={renaming}
          onClose={() => {
            setRenaming(null);
          }}
          onRename={(name) =>
            run(() => renameColumn(renaming.id, name)).then((error) => {
              if (error === null) {
                setRenaming(null);
              }
              return error;
            })
          }
        />
      )}
      <Dialog
        title="Delete this task for good?"
        description={
          deleting === null
            ? undefined
            : `“${deleting.title}” cannot be restored afterwards.`
        }
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        actions={
          <>
            <DialogClose>Keep it</DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                const task = deleting;
                setDeleting(null);
                if (task !== null) {
                  void act("The task was not deleted.", () =>
                    deleteTask(task.id).then(() => null),
                  ).then(refreshTrash);
                }
              }}
            >
              Delete for good
            </Button>
          </>
        }
      />
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <PageHeader title="Tasks" />
      <div className={styles.content}>{children}</div>
    </div>
  );
}

function RenameColumn({
  column,
  onClose,
  onRename,
}: {
  column: BoardColumn;
  onClose: () => void;
  onRename: (name: string) => Promise<CommandError | null>;
}) {
  const [name, setName] = useState(column.name);
  const [error, setError] = useState<CommandError | null>(null);
  return (
    <Dialog
      title="Rename column"
      open
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
              void onRename(name).then(setError);
            }}
          >
            Rename
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        value={name}
        autoComplete="off"
        error={error === null ? undefined : commandErrorMessage(error)}
        onValueChange={setName}
      />
    </Dialog>
  );
}
