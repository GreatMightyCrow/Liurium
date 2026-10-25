import { CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./StateView.module.css";

interface LoadingStateProps {
  /** What is loading, e.g. "Loading notes…". */
  label: string;
}

// Shown while a page waits for data. The status role lets screen readers read the label.
export function LoadingState({ label }: LoadingStateProps) {
  return (
    <div role="status" className={[styles.state, styles.loading].join(" ")}>
      <LoaderCircle
        className={[styles.icon, styles.spinner].join(" ")}
        strokeWidth={1.5}
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

interface MessageProps {
  title: string;
  description: string;
  /** Usually one button that leads out of the state. */
  action?: ReactNode;
}

interface EmptyStateProps extends MessageProps {
  icon: LucideIcon;
}

// Nothing to show yet: say what will appear here and, where possible, how to start.
export function EmptyState({ icon, ...message }: EmptyStateProps) {
  return <StateMessage icon={icon} {...message} />;
}

// Something failed; role="alert" announces it at once. Never pass raw error text:
// it can contain note content. Details belong in the console.
export function ErrorState(message: MessageProps) {
  return (
    <StateMessage icon={CircleX} tone="danger" role="alert" {...message} />
  );
}

interface StateMessageProps extends MessageProps {
  icon: LucideIcon;
  tone?: "danger";
  role?: "alert";
}

function StateMessage({
  icon: Icon,
  tone,
  role,
  title,
  description,
  action,
}: StateMessageProps) {
  return (
    <div
      role={role}
      className={[styles.state, tone === "danger" && styles.danger]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon className={styles.icon} strokeWidth={1.5} aria-hidden />
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description}</p>
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
