import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Separator } from "@base-ui/react/separator";
import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import styles from "./Menu.module.css";

interface MenuProps {
  /** The button that opens the menu. */
  trigger: ReactElement;
  children: ReactNode;
}

// Arrow keys move between items, Enter chooses, Escape closes and returns focus.
export function Menu({ trigger, children }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className={styles.positioner} align="start">
          <BaseMenu.Popup className={styles.menu}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

interface MenuItemProps {
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function MenuItem({ onSelect, disabled, children }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={styles.item}
      onClick={onSelect}
      disabled={disabled}
    >
      {children}
    </BaseMenu.Item>
  );
}

interface MenuCheckboxItemProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}

/** Stays open when chosen, so several can be ticked one after the other. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: MenuCheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem
      className={styles.item}
      checked={checked}
      onCheckedChange={(next) => {
        onCheckedChange(next);
      }}
      closeOnClick={false}
    >
      <BaseMenu.CheckboxItemIndicator className={styles.check} keepMounted>
        <Check className={styles.checkMark} strokeWidth={1.5} aria-hidden />
      </BaseMenu.CheckboxItemIndicator>
      <span className={styles.label}>{children}</span>
    </BaseMenu.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <Separator className={styles.separator} />;
}
