import type { ReactNode } from "react";
import type { FrameStyle } from "../app/frameStyle";
import styles from "./AppShell.module.css";

interface AppShellProps {
  frame: FrameStyle;
  /** Shown in the title bar of the Liurium frame. */
  title: string;
  /** Minimize, maximize, close; only rendered for the custom frames. */
  windowControls: ReactNode;
  sidebar: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
}

const frameClass: Record<FrameStyle, string | undefined> = {
  native: undefined,
  liurium: styles.liuriumFrame,
  hidden: undefined,
};

// Window layout. Sidebar and main area scroll on their own; the page itself never does.
// The window buttons come last in the markup, so they are last in tab order too;
// the grid places them top right. `data-frame` lets sidebar and page header turn
// into the drag area of the hidden frame.
export function AppShell({
  frame,
  title,
  windowControls,
  sidebar,
  statusBar,
  children,
}: AppShellProps) {
  return (
    <div
      className={[styles.shell, frameClass[frame]].join(" ")}
      data-frame={frame}
    >
      {frame === "liurium" && (
        <div className={styles.titleBar} data-testid="title-bar">
          <img
            className={styles.appIcon}
            src="/favicon.ico"
            alt=""
            draggable={false}
          />
          <span>{title}</span>
        </div>
      )}
      <nav aria-label="Primary" className={styles.sidebar}>
        {sidebar}
      </nav>
      <main className={styles.main}>{children}</main>
      <footer aria-label="Status bar" className={styles.statusBar}>
        {statusBar}
      </footer>
      {frame !== "native" && (
        <div className={styles.windowControls}>{windowControls}</div>
      )}
    </div>
  );
}
