import { ChevronDown } from "lucide-react";
import type { Ref } from "react";
import type { TaskPriority } from "../../lib/ipc/commands";
import { Button } from "../../ui/Button";
import { Menu, MenuCheckboxItem, MenuItem } from "../../ui/Menu";
import {
  type DueChoice,
  isFiltering,
  MAX_FILTER_TEXT,
  NO_FILTER,
  type TaskFilter,
} from "./filter";
import styles from "./TaskFilterBar.module.css";

const PRIORITIES: readonly (readonly [TaskPriority, string])[] = [
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["none", "No priority"],
];

const DUE: readonly (readonly [DueChoice, string])[] = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["week", "This week"],
  ["none", "No date"],
];

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  return on ? [...list, item] : list.filter((one) => one !== item);
}

interface ChoicesProps<T> {
  label: string;
  choices: readonly (readonly [T, string])[];
  chosen: readonly T[];
  empty?: string;
  onChange: (next: T[]) => void;
}

function Choices<T extends string>({
  label,
  choices,
  chosen,
  empty,
  onChange,
}: ChoicesProps<T>) {
  const active = chosen.length > 0;
  return (
    <Menu
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className={styles.choice}
          data-active={active ? "" : undefined}
        >
          {active ? `${label} (${String(chosen.length)})` : label}
          <ChevronDown className={styles.mark} strokeWidth={1.5} aria-hidden />
        </Button>
      }
    >
      {choices.length === 0 && (
        <MenuItem
          disabled
          onSelect={() => {
            // Only says that there is nothing to choose.
          }}
        >
          {empty}
        </MenuItem>
      )}
      {choices.map(([value, name]) => (
        <MenuCheckboxItem
          key={value}
          checked={chosen.includes(value)}
          onCheckedChange={(on) => {
            onChange(toggled(chosen, value, on));
          }}
        >
          {name}
        </MenuCheckboxItem>
      ))}
    </Menu>
  );
}

interface TaskFilterBarProps {
  filter: TaskFilter;
  tags: readonly string[];
  shown: number;
  total: number;
  /** The last task added does not fit the filters, so it cannot be seen. */
  addedHidden: boolean;
  searchFailed: boolean;
  field: Ref<HTMLInputElement>;
  onChange: (filter: TaskFilter) => void;
}

function summary(filtering: boolean, shown: number, total: number): string {
  if (!filtering) {
    return "";
  }
  return shown === 0
    ? "No task fits these filters."
    : `${String(shown)} of ${String(total)} tasks`;
}

// One way in for every filter, always in the same place (M4-008). What is active says
// so in words, so it also holds in contrast themes and for screen readers.
export function TaskFilterBar({
  filter,
  tags,
  shown,
  total,
  addedHidden,
  searchFailed,
  field,
  onChange,
}: TaskFilterBarProps) {
  const filtering = isFiltering(filter);
  return (
    <div className={styles.bar} role="search" aria-label="Filter tasks">
      <input
        ref={field}
        className={styles.field}
        type="search"
        aria-label="Filter by text"
        placeholder="Filter by text"
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_FILTER_TEXT}
        value={filter.text}
        onChange={(event) => {
          onChange({ ...filter, text: event.target.value });
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && filter.text !== "") {
            event.preventDefault();
            event.stopPropagation();
            onChange({ ...filter, text: "" });
          }
        }}
      />
      <Choices
        label="Tags"
        choices={tags.map((tag) => [tag, `#${tag}`] as const)}
        chosen={filter.tags}
        empty="No tags yet"
        onChange={(next) => {
          onChange({ ...filter, tags: next });
        }}
      />
      <Choices
        label="Priority"
        choices={PRIORITIES}
        chosen={filter.priorities}
        onChange={(next) => {
          onChange({ ...filter, priorities: next });
        }}
      />
      <Choices
        label="Due"
        choices={DUE}
        chosen={filter.due}
        onChange={(next) => {
          onChange({ ...filter, due: next });
        }}
      />
      {filtering && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(NO_FILTER);
          }}
        >
          Clear filters
        </Button>
      )}
      <p className={styles.count} role="status">
        {summary(filtering, shown, total)}
        {addedHidden && " The new task is hidden by the filters."}
      </p>
      {searchFailed && (
        <p className={styles.problem} role="alert">
          Descriptions could not be searched. Only titles and tags are filtered.
        </p>
      )}
    </div>
  );
}
