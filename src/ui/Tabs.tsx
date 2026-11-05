import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import styles from "./Tabs.module.css";

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

interface TabsProps<T extends string> {
  /** Names the row of tabs for screen readers. */
  label: string;
  value: T;
  options: readonly TabOption<T>[];
  onChange: (value: T) => void;
  /** What the chosen tab shows. */
  children: ReactNode;
}

// Arrow keys move between the tabs and Tab leaves the row, by Base UI.
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: TabsProps<T>) {
  return (
    <BaseTabs.Root
      className={styles.tabs}
      value={value}
      onValueChange={(next: T) => {
        onChange(next);
      }}
    >
      <BaseTabs.List className={styles.list} aria-label={label}>
        {options.map((option) => (
          <BaseTabs.Tab
            key={option.value}
            className={styles.tab}
            value={option.value}
          >
            {option.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      <BaseTabs.Panel className={styles.panel} value={value}>
        {children}
      </BaseTabs.Panel>
    </BaseTabs.Root>
  );
}
