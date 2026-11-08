import { FolderOpen, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type SearchResults, searchNotes } from "../../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { IconButton } from "../../ui/IconButton";
import { commandErrorMessage } from "../commandErrorMessage";
import styles from "./SearchPanel.module.css";

/** Typing waits this long before it asks, so a word is not searched letter by letter. */
export const SEARCH_DELAY_MS = 200;

type Answer =
  | { status: "ready"; query: string; results: SearchResults }
  | { status: "failed"; query: string; error: CommandError };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

function split(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut), name: path.slice(cut + 1) };
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

interface SearchPanelProps {
  query: string;
  onQuery: (query: string) => void;
  /** Changes when the field should take the focus (a shortcut or the sidebar). */
  focusKey: number;
  /** Changes when notes changed, so the same query is asked again. */
  refresh: number;
  /** Opens a note, at a place in its text (UTF-16) when there is one. */
  onOpen: (path: string, offset: number | null) => void;
  onOpenProject: (id: string) => void;
}

// The Search tab of the Notes page (M4-002): results while typing, the open
// project's notes first, then other projects by name. A result opens its note at
// the line that matched.
export function SearchPanel({
  query,
  onQuery,
  focusKey,
  refresh,
  onOpen,
  onOpenProject,
}: SearchPanelProps) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asked = query.trim();

  useEffect(() => {
    field.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    if (asked === "") {
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      searchNotes(asked).then(
        (results) => {
          if (current) {
            setAnswer({ status: "ready", query: asked, results });
          }
        },
        (reason: unknown) => {
          if (current) {
            setAnswer({
              status: "failed",
              query: asked,
              error: errorOf(reason),
            });
          }
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [asked, refresh]);

  const shown = asked === "" ? null : answer;
  const waiting = asked !== "" && answer?.query !== asked;
  const results = shown?.status === "ready" ? shown.results : null;
  const others = results?.projects.filter((project) => !project.open) ?? [];

  const resultButtons = (): HTMLButtonElement[] =>
    Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>("[data-result]") ?? [],
    );

  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      resultButtons()[0]?.focus();
    } else if (event.key === "Enter") {
      const first = results?.notes[0];
      if (first !== undefined && !waiting) {
        event.preventDefault();
        onOpen(first.path, first.excerpt?.offset ?? null);
      }
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQuery("");
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const all = resultButtons();
    const at = all.findIndex((button) => button === document.activeElement);
    if (at < 0) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") {
      all[Math.min(at + 1, all.length - 1)]?.focus();
    } else if (at === 0) {
      field.current?.focus();
    } else {
      all[at - 1]?.focus();
    }
  };

  let status: string;
  if (asked === "") {
    status = "Type to search the notes of this project.";
  } else if (waiting && shown === null) {
    status = "Searching…";
  } else if (shown?.status === "failed") {
    status = `Search failed. ${commandErrorMessage(shown.error)}`;
  } else if (results !== null) {
    const parts = [
      results.notes.length === 0
        ? "No notes match"
        : count(results.notes.length, "note", "notes"),
      others.length > 0 &&
        count(others.length, "other project", "other projects"),
    ].filter((part): part is string => typeof part === "string");
    status = parts.join(", ");
  } else {
    status = "Searching…";
  }

  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <Search className={styles.icon} strokeWidth={1.5} aria-hidden />
        <input
          ref={field}
          className={styles.input}
          type="search"
          aria-label="Search notes"
          placeholder="Search notes"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
          }}
          onKeyDown={onFieldKey}
        />
        {query !== "" && (
          <IconButton
            className={styles.clear}
            label="Clear search"
            icon={X}
            size="sm"
            onClick={() => {
              onQuery("");
              field.current?.focus();
            }}
          />
        )}
      </div>
      <p className={styles.status} role="status" aria-busy={waiting}>
        {status}
      </p>
      {results?.shortWords === true && (
        <p className={styles.hint}>
          Words shorter than three letters only match note names.
        </p>
      )}
      {results !== null && (
        <div
          ref={list}
          className={styles.results}
          data-stale={waiting ? "" : undefined}
          onKeyDown={onListKey}
        >
          {results.notes.length > 0 && (
            <ul className={styles.notes} aria-label="Notes">
              {results.notes.map((hit) => {
                const { folder, name } = split(hit.path);
                const excerpt = hit.excerpt;
                return (
                  <li key={hit.path}>
                    <button
                      type="button"
                      className={styles.hit}
                      data-result=""
                      onClick={() => {
                        onOpen(hit.path, excerpt?.offset ?? null);
                      }}
                    >
                      <span className={styles.name}>
                        {name}
                        {folder !== "" && (
                          <span className={styles.folder}>{folder}</span>
                        )}
                      </span>
                      {excerpt !== null && (
                        <span className={styles.line}>
                          {excerpt.line.slice(0, excerpt.from)}
                          <mark className={styles.match}>
                            {excerpt.line.slice(excerpt.from, excerpt.to)}
                          </mark>
                          {excerpt.line.slice(excerpt.to)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {others.length > 0 && (
            <section className={styles.projects} aria-label="Other projects">
              <h2 className={styles.heading}>Other projects</h2>
              <ul className={styles.notes}>
                {others.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={styles.hit}
                      data-result=""
                      onClick={() => {
                        onOpenProject(project.id);
                      }}
                    >
                      <span className={styles.name}>
                        <FolderOpen
                          className={styles.projectIcon}
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        {project.name}
                      </span>
                      <span className={styles.line}>Open this project</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
