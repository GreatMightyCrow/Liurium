import { CircleX, LoaderCircle } from "lucide-react";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type CommandError, CommandFailure } from "../../lib/ipc/errors";
import { Button } from "../../ui/Button";
import { commandErrorMessage } from "../commandErrorMessage";
import styles from "./Dashboard.module.css";

/** "normal" takes one cell of the grid; "wide" takes a whole row. */
export type WidgetSize = "normal" | "wide";

// The contract every dashboard widget follows (M4-005). The frame gives it a titled
// section and its own error boundary; the body loads its own data with
// `useWidgetData` and shows it with `WidgetContent`, so one widget that fails or
// throws never takes the others with it.
export interface WidgetDefinition {
  /** Stable name; a saved layout (M4-007) refers to widgets by it. */
  id: string;
  title: string;
  size: WidgetSize;
  Body: ComponentType;
}

export type WidgetData<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; error: CommandError };

/** Counts changes to notes outside Liurium; widgets load again when it moves. */
export const DashboardChanges = createContext(0);

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

/** Loads a widget's data once, again after `reload`, and again after outside changes.
 *  Data already shown stays while a later load runs, so the widget does not flicker. */
export function useWidgetData<T>(load: () => Promise<T>): {
  data: WidgetData<T>;
  reload: () => void;
} {
  const [data, setData] = useState<WidgetData<T>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const changes = useContext(DashboardChanges);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    let current = true;
    latest.current().then(
      (value) => {
        if (current) {
          setData({ status: "ready", value });
        }
      },
      (reason: unknown) => {
        if (current) {
          setData({ status: "failed", error: errorOf(reason) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [version, changes]);

  const reload = useCallback(() => {
    setData((last) =>
      last.status === "failed" ? { status: "loading" } : last,
    );
    setVersion((last) => last + 1);
  }, []);
  return { data, reload };
}

interface WidgetContentProps<T> {
  data: WidgetData<T>;
  /** What is loading, e.g. "Loading notes…". */
  loading: string;
  /** What failed, one sentence; the reason follows it. */
  failed: string;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}

// A widget's loading and error states, sized for a widget, not for a page. The
// error names the kind of failure only, never raw error text (it may hold note content).
export function WidgetContent<T>({
  data,
  loading,
  failed,
  onRetry,
  children,
}: WidgetContentProps<T>) {
  if (data.status === "loading") {
    return (
      <p role="status" className={styles.note}>
        <LoaderCircle
          className={[styles.icon, styles.spinner].join(" ")}
          strokeWidth={1.5}
          aria-hidden
        />
        {loading}
      </p>
    );
  }
  if (data.status === "failed") {
    return (
      <WidgetProblem
        text={`${failed} ${commandErrorMessage(data.error)}`}
        onRetry={onRetry}
      />
    );
  }
  return children(data.value);
}

interface WidgetProblemProps {
  text: string;
  onRetry: () => void;
}

export function WidgetProblem({ text, onRetry }: WidgetProblemProps) {
  return (
    <div role="alert" className={styles.problem}>
      <p className={styles.note}>
        <CircleX
          className={[styles.icon, styles.danger].join(" ")}
          strokeWidth={1.5}
          aria-hidden
        />
        {text}
      </p>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
