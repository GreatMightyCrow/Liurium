import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import styles from "./Tooltip.module.css";

/** Wait before a tooltip opens on hover; keyboard focus opens it at once. */
const OPEN_DELAY_MS = 500;

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={OPEN_DELAY_MS}>
      {children}
    </BaseTooltip.Provider>
  );
}

interface TooltipProps {
  label: string;
  /** The trigger. Its accessible name must say the same as `label`. */
  children: ReactElement;
}

// Tooltips are visual only (ADR-0012): screen readers get the trigger's own name.
export function Tooltip({ label, children }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className={styles.positioner}>
          <BaseTooltip.Popup className={styles.tooltip}>
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
