import type { PropertyKind, PropertyValue } from "../../lib/ipc/commands";

// What the properties box (M3-015) decides from a field's name and value. Rust reads
// and writes the YAML; this only chooses how a value shows.

export const KIND_NAMES: Record<PropertyKind, string> = {
  text: "Text",
  list: "List",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  dateTime: "Date and time",
};

const FIXED_LISTS = new Set(["tags", "tag", "aliases", "alias"]);
const TAG_LISTS = new Set(["tags", "tag"]);

export function isFixedList(name: string): boolean {
  return FIXED_LISTS.has(name.toLowerCase());
}

export function isTagList(name: string): boolean {
  return TAG_LISTS.has(name.toLowerCase());
}

type ShownValue = Exclude<PropertyValue, { kind: "asText" }>;

/** The name's fixed kind, else the one chosen in the project, else the value's. */
export function effectiveKind(
  name: string,
  value: ShownValue,
  chosen: ReadonlyMap<string, PropertyKind>,
): PropertyKind {
  if (isFixedList(name)) {
    return "list";
  }
  const kind = chosen.get(name.toLowerCase());
  if (kind !== undefined) {
    return kind;
  }
  return value.kind === "empty" ? "text" : value.kind;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** The value's text, whatever kind it was read as. */
export function displayText(value: ShownValue): string {
  switch (value.kind) {
    case "empty":
      return "";
    case "checkbox":
      return String(value.checked);
    case "list":
      return value.items.join(", ");
    default:
      return value.text;
  }
}

/** Whether a value can show in a kind's control without changing it. */
export function fits(kind: PropertyKind, value: ShownValue): boolean {
  if (value.kind === "empty" || value.kind === kind) {
    return true;
  }
  const text = displayText(value);
  switch (kind) {
    case "text":
      return value.kind !== "list";
    case "list":
      return value.kind !== "checkbox";
    case "number":
      return value.kind === "text" && NUMBER.test(text);
    case "date":
      return value.kind === "text" && DATE.test(text);
    case "dateTime":
      return value.kind === "text" && DATE_TIME.test(text);
    case "checkbox":
      return false;
  }
}

export function itemsOf(value: ShownValue): string[] {
  if (value.kind === "list") {
    return value.items;
  }
  const text = displayText(value);
  return text === "" ? [] : [text];
}

/** What a kind's control writes for this text. */
export function valueFor(kind: PropertyKind, text: string): PropertyValue {
  if (kind === "list") {
    return { kind: "list", items: text === "" ? [] : [text] };
  }
  if (kind === "checkbox") {
    return { kind: "checkbox", checked: text === "true" };
  }
  if (text === "") {
    return { kind: "empty" };
  }
  return { kind, text };
}

/** What was typed into a list: a tag list takes several, without their `#`. */
export function splitNewItems(name: string, typed: string): string[] {
  if (!isTagList(name)) {
    const item = typed.trim();
    return item === "" ? [] : [item];
  }
  return typed
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#+/, ""))
    .filter((tag) => tag !== "");
}
