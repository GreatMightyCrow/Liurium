import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type BacklinkSource, backlinksOf } from "../../lib/ipc/commands";
import styles from "./Backlinks.module.css";

type Loaded =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; sources: BacklinkSource[] };

/** Open or closed, remembered while the window is open. `null`: not chosen yet. */
let chosenOpen: boolean | null = null;

function split(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut), name: path.slice(cut + 1) };
}

interface BacklinksProps {
  /** The open note. */
  path: string;
  /** Opens a source note with the cursor at a place in its text (UTF-16). */
  onOpenAt: (path: string, offset: number) => void;
  /** Changes when notes changed outside Liurium, so the list is asked for again. */
  refresh?: number;
}

// The notes that link to the open one (M3-006), as a band at the bottom of the
// note: a button to open and close it, each source note with the line around
// each link; a click opens that note at the link.
export function Backlinks({ path, onOpenAt, refresh = 0 }: BacklinksProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [open, setOpen] = useState<boolean | null>(chosenOpen);
  const listId = useId();

  useEffect(() => {
    let current = true;
    backlinksOf(path).then(
      (sources) => {
        if (current) {
          setLoaded({ status: "ready", sources });
        }
      },
      () => {
        if (current) {
          setLoaded({ status: "failed" });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [path, refresh]);

  if (loaded.status === "loading") {
    return null;
  }
  if (loaded.status === "failed") {
    return (
      <section className={styles.band} aria-label="Backlinks">
        <p className={styles.quiet}>Backlinks could not be loaded.</p>
      </section>
    );
  }
  const { sources } = loaded;
  if (sources.length === 0) {
    return (
      <section className={styles.band} aria-label="Backlinks">
        <p className={styles.quiet}>No other note links here yet.</p>
      </section>
    );
  }
  const shown = open ?? true;
  const count = sources.length;
  return (
    <section className={styles.band} aria-label="Backlinks">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={shown}
        aria-controls={listId}
        onClick={() => {
          chosenOpen = !shown;
          setOpen(!shown);
        }}
      >
        <ChevronRight
          className={styles.chevron}
          data-open={shown ? "" : undefined}
          strokeWidth={1.5}
          aria-hidden
        />
        {`Linked from ${String(count)} ${count === 1 ? "note" : "notes"}`}
      </button>
      {shown && (
        <ul id={listId} className={styles.sources}>
          {sources.map((source) => {
            const { folder, name } = split(source.path);
            return (
              <li key={source.path} className={styles.source}>
                <p className={styles.sourceName}>
                  {name}
                  {folder !== "" && (
                    <span className={styles.folder}>{folder}</span>
                  )}
                </p>
                <ul className={styles.lines}>
                  {source.links.map((link) => (
                    <li key={link.offset}>
                      <button
                        type="button"
                        className={styles.line}
                        aria-label={`Open ${name} at: ${link.line}`}
                        onClick={() => {
                          onOpenAt(source.path, link.offset);
                        }}
                      >
                        {link.line.slice(0, link.from)}
                        <span className={styles.link}>
                          {link.line.slice(link.from, link.to)}
                        </span>
                        {link.line.slice(link.to)}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
