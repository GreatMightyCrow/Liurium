import { Copy, Minus, Square, X } from "lucide-react";
import styles from "./WindowControls.module.css";

interface WindowControlsProps {
  maximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

// Minimize, maximize/restore, and close for the custom frame styles (ADR-0013).
export function WindowControls({
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: WindowControlsProps) {
  const MaximizeIcon = maximized ? Copy : Square;
  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={styles.button}
        aria-label="Minimize"
        onClick={onMinimize}
      >
        <Minus className={styles.icon} strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={onToggleMaximize}
      >
        <MaximizeIcon className={styles.icon} strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.close}`}
        aria-label="Close"
        onClick={onClose}
      >
        <X className={styles.icon} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
