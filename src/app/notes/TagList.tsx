import { X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { LoadingState } from "../../ui/StateView";
import { commandErrorMessage } from "../commandErrorMessage";
import { sameTag, type TagsState } from "./tags";
import styles from "./TagList.module.css";

const count = new Intl.NumberFormat("en");

// Every tag of the project with how many notes carry it (M3-007). Plain rows, in
// the same quiet look as the notes tree: choosing one filters the tree.
export function TagList({
  state,
  chosen,
  onChoose,
}: {
  state: TagsState;
  chosen: string | null;
  onChoose: (tag: string) => void;
}) {
  if (state.status === "loading") {
    return <LoadingState label="Reading tags…" />;
  }
  if (state.status === "failed") {
    return <TagsFailed state={state} />;
  }
  if (state.rows.length === 0) {
    return (
      <p className={styles.text}>
        No tags yet. Write #tag in a note, or add tags: to its front matter.
      </p>
    );
  }
  return (
    <ul className={styles.rows} role="list">
      {state.rows.map(({ tag, notes }) => (
        <li key={tag.toLowerCase()}>
          <button
            type="button"
            className={styles.row}
            aria-current={
              chosen !== null && sameTag(chosen, tag) ? "true" : undefined
            }
            onClick={() => {
              onChoose(tag);
            }}
          >
            <span className={styles.tag}>{`#${tag}`}</span>{" "}
            <span className={styles.count}>
              {count.format(notes.length)}{" "}
              <span className={styles.hidden}>
                {notes.length === 1 ? "note" : "notes"}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TagsFailed({
  state,
}: {
  state: Extract<TagsState, { status: "failed" }>;
}) {
  return (
    <p className={styles.text} role="alert">
      {`Tags could not be read. ${commandErrorMessage(state.error)}`}
    </p>
  );
}

/** Above the tree while it shows one tag's notes. */
export function TagFilterBar({
  tag,
  onClear,
}: {
  tag: string;
  onClear: () => void;
}) {
  return (
    <div className={styles.filter} role="status">
      <p className={styles.filterText}>{`Showing notes tagged #${tag}`}</p>
      <IconButton label="Show all notes" icon={X} size="sm" onClick={onClear} />
    </div>
  );
}
