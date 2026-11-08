import { AlignLeft, Ellipsis, FileText, Plus } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  Board,
  BoardColumn,
  Task,
  TaskPriority,
} from "../../lib/ipc/commands";
import type { CommandError } from "../../lib/ipc/errors";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu";
import { commandErrorMessage } from "../commandErrorMessage";
import {
  dueLabel,
  isArrowKey,
  keyboardTarget,
  neighbour,
  type Target,
  taskIn,
  today,
} from "./board";
import styles from "./TaskBoard.module.css";
import { type Drag, useCardDrag } from "./useCardDrag";

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "",
  low: "Low",
  medium: "Medium",
  high: "High",
};

interface TaskBoardProps {
  board: Board;
  readOnly: boolean;
  /** The task open in the side panel. */
  selected: string | null;
  onOpen: (task: string) => void;
  onMove: (task: string, target: Target) => void;
  onAddTask: (column: string, title: string) => Promise<CommandError | null>;
  onAddColumn: (name: string) => Promise<CommandError | null>;
  onRenameColumn: (column: BoardColumn) => void;
  onMoveColumn: (column: string, index: number) => void;
  onDeleteColumn: (column: string) => void;
}

function cardOf(task: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-task]")].find(
    (card) => card.dataset.task === task,
  );
}

export function focusCard(task: string): void {
  cardOf(task)?.focus();
}

// Columns side by side, each with its cards in order (M4-004). One Tab stop for all
// cards: arrows walk through them, Ctrl + arrows move the card, Enter opens it.
export function TaskBoard({
  board,
  readOnly,
  selected,
  onOpen,
  onMove,
  onAddTask,
  onAddColumn,
  onRenameColumn,
  onMoveColumn,
  onDeleteColumn,
}: TaskBoardProps) {
  const [active, setActive] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<string | null>(null);
  const { drag, startDrag } = useCardDrag(onMove, !readOnly);

  const tabStop =
    active !== null && taskIn(board, active) !== null
      ? active
      : (board.columns.flatMap((column) => column.tasks)[0]?.id ?? null);

  useLayoutEffect(() => {
    if (refocus.current !== null) {
      focusCard(refocus.current);
      refocus.current = null;
    }
  }, [board]);

  const onCardKey = (event: KeyboardEvent<HTMLElement>, task: Task) => {
    if (!isArrowKey(event.key)) {
      return;
    }
    event.preventDefault();
    if (!event.ctrlKey) {
      const next = neighbour(board, task.id, event.key);
      if (next !== null) {
        focusCard(next);
      }
      return;
    }
    if (readOnly) {
      return;
    }
    const target = keyboardTarget(board, task.id, event.key);
    if (target === null) {
      setAnnouncement(`${task.title} cannot move further.`);
      return;
    }
    const column = board.columns.find((one) => one.id === target.column);
    const count =
      (column?.tasks.filter((one) => one.id !== task.id).length ?? 0) + 1;
    refocus.current = task.id;
    onMove(task.id, target);
    setAnnouncement(
      `${task.title} moved to ${column?.name ?? ""}, position ${String(target.index + 1)} of ${String(count)}.`,
    );
  };

  return (
    <div className={styles.board} data-board="">
      {board.columns.map((column, columnIndex) => (
        <ColumnView
          key={column.id}
          column={column}
          first={columnIndex === 0}
          last={columnIndex === board.columns.length - 1}
          only={board.columns.length === 1}
          position={columnIndex}
          readOnly={readOnly}
          selected={selected}
          tabStop={tabStop}
          drag={drag}
          onOpen={onOpen}
          onFocusCard={setActive}
          onCardKey={onCardKey}
          startDrag={startDrag}
          onAddTask={onAddTask}
          onRename={() => {
            onRenameColumn(column);
          }}
          onMove={onMoveColumn}
          onDelete={onDeleteColumn}
        />
      ))}
      {!readOnly && <AddColumn onAdd={onAddColumn} />}
      <p className={styles.hidden} role="status">
        {announcement}
      </p>
      {drag !== null &&
        createPortal(
          <div
            className={styles.ghost}
            style={{
              transform: `translate(${String(drag.x)}px, ${String(drag.y)}px)`,
            }}
            aria-hidden="true"
          >
            {drag.title}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface ColumnViewProps {
  column: BoardColumn;
  first: boolean;
  last: boolean;
  only: boolean;
  position: number;
  readOnly: boolean;
  selected: string | null;
  tabStop: string | null;
  drag: Drag | null;
  onOpen: (task: string) => void;
  onFocusCard: (task: string) => void;
  onCardKey: (event: KeyboardEvent<HTMLElement>, task: Task) => void;
  startDrag: ReturnType<typeof useCardDrag>["startDrag"];
  onAddTask: TaskBoardProps["onAddTask"];
  onRename: () => void;
  onMove: (column: string, index: number) => void;
  onDelete: (column: string) => void;
}

function ColumnView({
  column,
  first,
  last,
  only,
  position,
  readOnly,
  selected,
  tabStop,
  drag,
  onOpen,
  onFocusCard,
  onCardKey,
  startDrag,
  onAddTask,
  onRename,
  onMove,
  onDelete,
}: ColumnViewProps) {
  const dropIndex = drag?.over?.column === column.id ? drag.over.index : null;
  const visible = column.tasks.filter((task) => task.id !== drag?.task);
  const line = <li className={styles.dropLine} aria-hidden="true" />;

  return (
    <section
      className={styles.column}
      data-column={column.id}
      aria-label={column.name}
    >
      <header className={styles.columnHeader}>
        <h2 className={styles.columnName}>{column.name}</h2>
        <span className={styles.count}>
          <span className={styles.hidden}>Tasks: </span>
          {column.tasks.length}
        </span>
        {!readOnly && (
          <Menu
            trigger={
              <IconButton
                className={styles.columnMenu}
                icon={Ellipsis}
                label={`Actions for ${column.name}`}
                size="sm"
              />
            }
          >
            <MenuItem onSelect={onRename}>Rename…</MenuItem>
            <MenuItem
              disabled={first}
              onSelect={() => {
                onMove(column.id, position - 1);
              }}
            >
              Move left
            </MenuItem>
            <MenuItem
              disabled={last}
              onSelect={() => {
                onMove(column.id, position + 1);
              }}
            >
              Move right
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={only}
              onSelect={() => {
                onDelete(column.id);
              }}
            >
              Delete column
            </MenuItem>
          </Menu>
        )}
      </header>
      <ul className={styles.cards} data-column-list="">
        {column.tasks.map((task) => {
          const dragged = task.id === drag?.task;
          const index = visible.findIndex((one) => one.id === task.id);
          return (
            <CardRow
              key={task.id}
              task={task}
              dragged={dragged}
              selected={selected === task.id}
              tabStop={tabStop === task.id}
              line={!dragged && dropIndex === index ? line : null}
              readOnly={readOnly}
              onOpen={onOpen}
              onFocusCard={onFocusCard}
              onCardKey={onCardKey}
              startDrag={startDrag}
            />
          );
        })}
        {dropIndex === visible.length && line}
      </ul>
      {!readOnly && <AddTask column={column.id} onAdd={onAddTask} />}
    </section>
  );
}

interface CardRowProps {
  task: Task;
  dragged: boolean;
  selected: boolean;
  tabStop: boolean;
  line: React.ReactNode;
  readOnly: boolean;
  onOpen: (task: string) => void;
  onFocusCard: (task: string) => void;
  onCardKey: (event: KeyboardEvent<HTMLElement>, task: Task) => void;
  startDrag: ReturnType<typeof useCardDrag>["startDrag"];
}

function CardRow({
  task,
  dragged,
  selected,
  tabStop,
  line,
  readOnly,
  onOpen,
  onFocusCard,
  onCardKey,
  startDrag,
}: CardRowProps) {
  const overdue = task.due !== null && task.due < today();
  const priority = PRIORITY_LABEL[task.priority];
  const hasFooter =
    priority !== "" ||
    task.due !== null ||
    task.tags.length > 0 ||
    task.hasDescription ||
    task.notes.length > 0;
  return (
    <>
      {line}
      <li>
        <button
          type="button"
          className={styles.card}
          data-task={task.id}
          data-dragged={dragged ? "" : undefined}
          aria-pressed={selected}
          aria-keyshortcuts={readOnly ? undefined : "Control+ArrowUp"}
          tabIndex={tabStop ? 0 : -1}
          onClick={() => {
            onOpen(task.id);
          }}
          onFocus={() => {
            onFocusCard(task.id);
          }}
          onKeyDown={(event) => {
            onCardKey(event, task);
          }}
          onPointerDown={(event) => {
            startDrag(event, task.id, task.title);
          }}
        >
          <span className={styles.title}>{task.title}</span>
          {hasFooter && (
            <span className={styles.footer}>
              {priority !== "" && (
                <span className={styles.priority} data-priority={task.priority}>
                  <span className={styles.hidden}>Priority: </span>
                  {priority}
                </span>
              )}
              {task.due !== null && (
                <span
                  className={styles.due}
                  data-overdue={overdue ? "" : undefined}
                >
                  {overdue ? "Overdue: " : "Due: "}
                  {dueLabel(task.due)}
                </span>
              )}
              {task.tags.slice(0, 3).map((tag) => (
                <span key={tag} className={styles.tag}>
                  #{tag}
                </span>
              ))}
              {task.tags.length > 3 && (
                <span className={styles.tag}>+{task.tags.length - 3}</span>
              )}
              {task.hasDescription && (
                <AlignLeft
                  className={styles.mark}
                  strokeWidth={1.5}
                  role="img"
                  aria-label="Has a description"
                />
              )}
              {task.notes.length > 0 && (
                <span className={styles.notes}>
                  <FileText
                    className={styles.mark}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <span className={styles.hidden}>Linked notes: </span>
                  {task.notes.length}
                </span>
              )}
            </span>
          )}
        </button>
      </li>
    </>
  );
}

interface AddLineProps {
  label: string;
  fieldLabel: string;
  className: string;
  onAdd: (text: string) => Promise<CommandError | null>;
  /** After adding, the field stays open for the next one. */
  stayOpen: boolean;
}

function AddLine({
  label,
  fieldLabel,
  className,
  onAdd,
  stayOpen,
}: AddLineProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<CommandError | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      field.current?.focus();
    } else if (wasOpen.current) {
      button.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const close = () => {
    setOpen(false);
    setText("");
    setError(null);
  };

  const submit = () => {
    if (text.trim() === "" || busy) {
      return;
    }
    setBusy(true);
    void onAdd(text).then((failure) => {
      setBusy(false);
      setError(failure);
      if (failure === null) {
        if (stayOpen) {
          setText("");
          field.current?.focus();
        } else {
          close();
        }
      }
    });
  };

  if (!open) {
    return (
      <Button
        ref={button}
        className={className}
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Plus className={styles.mark} strokeWidth={1.5} aria-hidden />
        {label}
      </Button>
    );
  }
  return (
    <div className={styles.addLine}>
      <input
        ref={field}
        className={styles.addField}
        aria-label={fieldLabel}
        placeholder={fieldLabel}
        autoComplete="off"
        spellCheck={false}
        value={text}
        aria-invalid={error !== null}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        onBlur={() => {
          if (text.trim() === "") {
            close();
          }
        }}
      />
      {error !== null && (
        <p className={styles.addError} role="alert">
          {commandErrorMessage(error)}
        </p>
      )}
    </div>
  );
}

function AddTask({
  column,
  onAdd,
}: {
  column: string;
  onAdd: TaskBoardProps["onAddTask"];
}) {
  return (
    <AddLine
      label="Add task"
      fieldLabel="Task title"
      className={styles.add}
      stayOpen
      onAdd={(title) => onAdd(column, title)}
    />
  );
}

function AddColumn({ onAdd }: { onAdd: TaskBoardProps["onAddColumn"] }) {
  return (
    <div className={styles.addColumn}>
      <AddLine
        label="Add column"
        fieldLabel="Column name"
        className={styles.add}
        stayOpen={false}
        onAdd={onAdd}
      />
    </div>
  );
}
