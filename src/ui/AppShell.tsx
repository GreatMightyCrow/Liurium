import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

interface AppShellProps {
  sidebar: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
}

// Window layout. Sidebar and main area scroll on their own; the page itself never does.
export function AppShell({ sidebar, statusBar, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <nav aria-label="Primary" className={styles.sidebar}>
        {sidebar}
      </nav>
      <main className={styles.main}>{children}</main>
      <footer aria-label="Status bar" className={styles.statusBar}>
        {statusBar}
      </footer>
    </div>
  );
}
