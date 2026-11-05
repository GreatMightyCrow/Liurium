import { Menu as BaseMenu } from "@base-ui/react/menu";
import {
  Braces,
  Calendar,
  CalendarClock,
  CheckSquare,
  Hash,
  List,
  Plus,
  Tags,
  Text,
  X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import type {
  NoteProperties,
  PropertyEdit,
  PropertyField,
  PropertyKind,
  PropertyValue,
} from "../../lib/ipc/commands";
import { Button } from "../../ui/Button";
import menuStyles from "../../ui/Menu.module.css";
import {
  displayText,
  effectiveKind,
  fits,
  isFixedList,
  isTagList,
  itemsOf,
  KIND_NAMES,
  splitNewItems,
  valueFor,
} from "./properties";
import styles from "./PropertiesBox.module.css";

const iconProps = {
  className: styles.icon,
  strokeWidth: 1.5,
  "aria-hidden": true,
};

const KIND_ICONS: Record<PropertyKind, ReactNode> = {
  text: <Text {...iconProps} />,
  list: <List {...iconProps} />,
  number: <Hash {...iconProps} />,
  checkbox: <CheckSquare {...iconProps} />,
  date: <Calendar {...iconProps} />,
  dateTime: <CalendarClock {...iconProps} />,
};

const KINDS = Object.keys(KIND_NAMES) as PropertyKind[];

function iconOf(name: string, kind: PropertyKind): ReactNode {
  return isTagList(name) ? <Tags {...iconProps} /> : KIND_ICONS[kind];
}

interface PropertiesBoxProps {
  properties: Extract<NoteProperties, { state: "fields" }> | null;
  /** The kinds chosen in this project, by lowercase name. */
  kinds: ReadonlyMap<string, PropertyKind>;
  readOnly: boolean;
  error: string | null;
  onEdit: (edit: PropertyEdit) => void;
  /** Chooses a kind for a name; `null` follows the value again. */
  onKind: (name: string, kind: PropertyKind | null) => void;
  /** Shows the notes of a tag. */
  onTag: (tag: string) => void;
  onEditAsText: () => void;
}

// The front matter as a box above the note (M3-015, as in Obsidian). Every change goes
// through Rust as one text edit, so it undoes and saves like typing.
export function PropertiesBox({
  properties,
  kinds,
  readOnly,
  error,
  onEdit,
  onKind,
  onTag,
  onEditAsText,
}: PropertiesBoxProps) {
  const fields = properties?.fields ?? [];
  if (fields.length === 0 && readOnly) {
    return null;
  }
  return (
    <section className={styles.box} aria-label="Properties">
      {fields.length > 0 && (
        <div className={styles.head}>
          <h3 className={styles.title}>Properties</h3>
          <Button size="sm" variant="ghost" onClick={onEditAsText}>
            Edit as text
          </Button>
        </div>
      )}
      {fields.length > 0 && (
        <ul className={styles.rows} role="list">
          {fields.map((field) => (
            <Row
              key={field.name}
              field={field}
              kinds={kinds}
              readOnly={readOnly}
              onEdit={onEdit}
              onKind={onKind}
              onTag={onTag}
            />
          ))}
        </ul>
      )}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!readOnly && (
        <AddProperty
          taken={fields.map((field) => field.name)}
          kinds={kinds}
          onEdit={onEdit}
          onKind={onKind}
        />
      )}
    </section>
  );
}

function Row({
  field,
  kinds,
  readOnly,
  onEdit,
  onKind,
  onTag,
}: {
  field: PropertyField;
  kinds: ReadonlyMap<string, PropertyKind>;
  readOnly: boolean;
  onEdit: (edit: PropertyEdit) => void;
  onKind: (name: string, kind: PropertyKind | null) => void;
  onTag: (tag: string) => void;
}) {
  const { name, value } = field;
  const set = (next: PropertyValue) => {
    onEdit({ action: "set", name, value: next });
  };
  if (value.kind === "asText") {
    return (
      <li className={styles.row}>
        <div className={styles.label}>
          <span className={styles.staticIcon}>
            <Braces {...iconProps} />
          </span>
          <span className={styles.staticName}>{name}</span>
        </div>
        <pre className={styles.source}>{value.source}</pre>
      </li>
    );
  }
  const kind = effectiveKind(name, value, kinds);
  return (
    <li className={styles.row}>
      <div className={styles.label}>
        {readOnly ? (
          <span className={styles.staticIcon}>{iconOf(name, kind)}</span>
        ) : (
          <KindMenu
            name={name}
            kind={kind}
            chosen={kinds.has(name.toLowerCase())}
            onKind={onKind}
            onRemove={() => {
              onEdit({ action: "remove", name });
            }}
          />
        )}
        {readOnly ? (
          <span className={styles.staticName}>{name}</span>
        ) : (
          <TextInput
            className={styles.name}
            label={`Name of property ${name}`}
            value={name}
            onCommit={(to) => {
              if (to.trim() !== "") {
                onEdit({ action: "rename", name, to: to.trim() });
              }
            }}
          />
        )}
      </div>
      <ValueControl
        name={name}
        kind={kind}
        value={value}
        readOnly={readOnly}
        onSet={set}
        onTag={onTag}
      />
    </li>
  );
}

function KindMenu({
  name,
  kind,
  chosen,
  onKind,
  onRemove,
}: {
  name: string;
  kind: PropertyKind;
  chosen: boolean;
  onKind: (name: string, kind: PropertyKind | null) => void;
  onRemove: () => void;
}) {
  const fixed = isFixedList(name);
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        className={styles.kind}
        aria-label={`${name}: ${KIND_NAMES[kind]}. Change kind or remove`}
      >
        {iconOf(name, kind)}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className={menuStyles.positioner} align="start">
          <BaseMenu.Popup className={menuStyles.menu}>
            {!fixed &&
              KINDS.map((option) => (
                <BaseMenu.Item
                  key={option}
                  className={menuStyles.item}
                  onClick={() => {
                    onKind(name, option);
                  }}
                >
                  {KIND_ICONS[option]}
                  {option === kind
                    ? `${KIND_NAMES[option]} (current)`
                    : KIND_NAMES[option]}
                </BaseMenu.Item>
              ))}
            {!fixed && chosen && (
              <BaseMenu.Item
                className={menuStyles.item}
                onClick={() => {
                  onKind(name, null);
                }}
              >
                Decide by the value
              </BaseMenu.Item>
            )}
            <BaseMenu.Item className={menuStyles.item} onClick={onRemove}>
              <X {...iconProps} />
              Remove property
            </BaseMenu.Item>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** A value that fits only after the user changes it stays as written, and says so. */
function ValueControl({
  name,
  kind,
  value,
  readOnly,
  onSet,
  onTag,
}: {
  name: string;
  kind: PropertyKind;
  value: Exclude<PropertyValue, { kind: "asText" }>;
  readOnly: boolean;
  onSet: (value: PropertyValue) => void;
  onTag: (tag: string) => void;
}) {
  const hintId = useId();
  const label = `Value of property ${name}`;
  if (!fits(kind, value)) {
    return (
      <div className={styles.value}>
        <TextInput
          className={styles.input}
          label={label}
          value={displayText(value)}
          readOnly={readOnly}
          describedBy={hintId}
          onCommit={(text) => {
            onSet(valueFor(kind, text));
          }}
        />
        <p id={hintId} className={styles.hint}>
          {`Not a ${KIND_NAMES[kind].toLowerCase()}. It stays as written until you change it.`}
        </p>
      </div>
    );
  }
  if (kind === "list") {
    return (
      <ListControl
        name={name}
        items={itemsOf(value)}
        readOnly={readOnly}
        onSet={(items) => {
          onSet({ kind: "list", items });
        }}
        onTag={onTag}
      />
    );
  }
  if (kind === "checkbox") {
    return (
      <div className={styles.value}>
        <input
          type="checkbox"
          className={styles.checkbox}
          aria-label={label}
          checked={value.kind === "checkbox" && value.checked}
          disabled={readOnly}
          onChange={(event) => {
            onSet({ kind: "checkbox", checked: event.target.checked });
          }}
        />
      </div>
    );
  }
  return (
    <div className={styles.value}>
      <TextInput
        className={styles.input}
        label={label}
        value={displayText(value)}
        readOnly={readOnly}
        placeholder="Empty"
        type={
          kind === "date"
            ? "date"
            : kind === "dateTime"
              ? "datetime-local"
              : "text"
        }
        inputMode={kind === "number" ? "decimal" : undefined}
        onCommit={(text) => {
          onSet(valueFor(kind, text));
        }}
      />
    </div>
  );
}

function ListControl({
  name,
  items,
  readOnly,
  onSet,
  onTag,
}: {
  name: string;
  items: readonly string[];
  readOnly: boolean;
  onSet: (items: string[]) => void;
  onTag: (tag: string) => void;
}) {
  const [typing, setTyping] = useState("");
  const tagged = isTagList(name);
  const add = () => {
    const fresh = splitNewItems(name, typing).filter(
      (item) => !items.includes(item),
    );
    setTyping("");
    if (fresh.length > 0) {
      onSet([...items, ...fresh]);
    }
  };
  const remove = (item: string) => {
    onSet(items.filter((other) => other !== item));
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && typing === "" && items.length > 0) {
      remove(items[items.length - 1]);
    }
  };
  return (
    <div className={styles.value}>
      <ul className={styles.items} role="list">
        {items.map((item) => (
          <li key={item} className={styles.capsule}>
            {tagged ? (
              <button
                type="button"
                className={styles.capsuleText}
                onClick={() => {
                  onTag(item.replace(/^#+/, ""));
                }}
              >
                {item}
              </button>
            ) : (
              <span className={styles.capsuleText}>{item}</span>
            )}
            {!readOnly && (
              <button
                type="button"
                className={styles.capsuleRemove}
                aria-label={`Remove ${item}`}
                onClick={() => {
                  remove(item);
                }}
              >
                <X
                  className={styles.capsuleIcon}
                  strokeWidth={1.5}
                  aria-hidden
                />
              </button>
            )}
          </li>
        ))}
        {!readOnly && (
          <li className={styles.adding}>
            <input
              type="text"
              className={styles.addItem}
              aria-label={`Add to ${name}`}
              placeholder={items.length === 0 ? "Add…" : undefined}
              value={typing}
              onChange={(event) => {
                setTyping(event.target.value);
              }}
              onKeyDown={keys}
              onBlur={add}
            />
          </li>
        )}
      </ul>
    </div>
  );
}

/** A field that reports its text when it is left or on Enter; Escape takes it back.
 *  The value from Rust replaces what is shown once it changes. */
function TextInput({
  className,
  label,
  value,
  onCommit,
  readOnly,
  placeholder,
  type = "text",
  inputMode,
  describedBy,
}: {
  className: string;
  label: string;
  value: string;
  onCommit: (text: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  type?: "text" | "date" | "datetime-local";
  inputMode?: "decimal";
  describedBy?: string;
}): ReactNode {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };
  return (
    <input
      type={type}
      className={className}
      aria-label={label}
      aria-describedby={describedBy}
      value={draft}
      readOnly={readOnly}
      placeholder={placeholder}
      inputMode={inputMode}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          setDraft(value);
        }
      }}
    />
  );
}

function AddProperty({
  taken,
  kinds,
  onEdit,
  onKind,
}: {
  taken: readonly string[];
  kinds: ReadonlyMap<string, PropertyKind>;
  onEdit: (edit: PropertyEdit) => void;
  onKind: (name: string, kind: PropertyKind | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PropertyKind>("text");
  const nameKey = name.trim().toLowerCase();
  const fixed = isFixedList(nameKey);
  const known = kinds.get(nameKey);
  const shownKind = fixed ? "list" : (known ?? kind);
  const exists = taken.some((other) => other.toLowerCase() === nameKey);

  const close = () => {
    setAdding(false);
    setName("");
    setKind("text");
  };
  const add = () => {
    const clean = name.trim();
    if (clean === "" || exists) {
      return;
    }
    onEdit({ action: "set", name: clean, value: valueFor(shownKind, "") });
    if (!fixed && known !== shownKind && shownKind !== "text") {
      onKind(clean, shownKind);
    }
    close();
  };

  if (!adding) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAdding(true);
        }}
      >
        <Plus {...iconProps} />
        Add property
      </Button>
    );
  }
  return (
    <div
      className={styles.addRow}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
        }
      }}
    >
      <input
        type="text"
        className={styles.input}
        aria-label="Name of the new property"
        placeholder="Name"
        autoFocus
        value={name}
        spellCheck={false}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            add();
          }
        }}
      />
      <select
        className={styles.select}
        aria-label="Kind of the new property"
        value={shownKind}
        disabled={fixed || known !== undefined}
        onChange={(event) => {
          setKind(event.target.value as PropertyKind);
        }}
      >
        {KINDS.map((option) => (
          <option key={option} value={option}>
            {KIND_NAMES[option]}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={name.trim() === "" || exists} onClick={add}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={close}>
        Cancel
      </Button>
      {exists && (
        <p className={styles.hint} role="status">
          This note already has this property.
        </p>
      )}
    </div>
  );
}
