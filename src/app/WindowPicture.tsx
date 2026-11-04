import { useSyncExternalStore } from "react";
import type { FrameStyle } from "./frameStyle";
import type { Mode, Theme } from "./theme";
import styles from "./WindowPicture.module.css";

interface WindowPictureProps {
  theme: Theme;
  mode: Mode;
  frame?: FrameStyle;
  /** "Same as Windows": the right half shows the other mode. */
  splitWith?: Mode;
}

// A small Liurium window in a theme (M3-009). The colors come from tokens.css: each
// theme block also applies to `[data-preview]`, so the picture uses the same values as
// the real theme. Decorative; the tile's name says what it is.
export function WindowPicture({
  theme,
  mode,
  frame = "liurium",
  splitWith,
}: WindowPictureProps) {
  return (
    <span className={styles.frame}>
      <Window theme={theme} mode={mode} frame={frame} />
      {splitWith !== undefined && (
        <span className={styles.half}>
          <Window theme={theme} mode={splitWith} frame={frame} />
        </span>
      )}
    </span>
  );
}

function Window({
  theme,
  mode,
  frame,
}: {
  theme: Theme;
  mode: Mode;
  frame: FrameStyle;
}) {
  return (
    <span
      className={styles.window}
      data-preview=""
      data-accent={theme.accent}
      data-base={theme.base}
      data-mode={mode}
      data-frame={frame}
    >
      {frame !== "hidden" && (
        <span className={styles.bar}>
          {frame === "liurium" && <span className={styles.icon} />}
          <span className={styles.buttons}>
            <span />
            <span />
            <span />
          </span>
        </span>
      )}
      <span className={styles.body}>
        <span className={styles.side}>
          <span className={styles.nav} />
          <span className={`${styles.nav} ${styles.current}`} />
          <span className={styles.nav} />
          <span className={styles.nav} />
        </span>
        <span className={styles.main}>
          <span className={styles.heading} />
          <span className={styles.line} />
          <span className={`${styles.line} ${styles.short}`} />
          <span className={styles.button} />
        </span>
      </span>
    </span>
  );
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode"],
  });
  return () => {
    observer.disconnect();
  };
}

/** The mode the page shows now; it follows Windows or the chosen mode. */
export function usePageMode(): Mode {
  return useSyncExternalStore(subscribe, () =>
    document.documentElement.dataset.mode === "light" ? "light" : "dark",
  );
}
