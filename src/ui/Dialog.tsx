import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import styles from "./Dialog.module.css";

interface DialogProps {
  title: string;
  description?: string;
  /** Opens the dialog; omit when `open` is controlled from outside. */
  trigger?: ReactElement;
  /** Buttons at the bottom, e.g. `DialogClose` and a primary action. */
  actions?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

// Modal dialog: focus moves in and stays in, Escape closes, focus returns to the trigger.
export function Dialog({
  title,
  description,
  trigger,
  actions,
  open,
  onOpenChange,
  children,
}: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger !== undefined && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={styles.backdrop} />
        <BaseDialog.Popup className={styles.popup}>
          <BaseDialog.Title className={styles.title}>{title}</BaseDialog.Title>
          {description !== undefined && (
            <BaseDialog.Description className={styles.description}>
              {description}
            </BaseDialog.Description>
          )}
          {children}
          {actions !== undefined && (
            <div className={styles.actions}>{actions}</div>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** A button that closes the surrounding dialog. */
export function DialogClose(props: ButtonProps) {
  return <BaseDialog.Close render={<Button {...props} />} />;
}
