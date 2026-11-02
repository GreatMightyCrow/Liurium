import type { ThemeChoice } from "../lib/ipc/commands";

// Color themes (ADR-0015): an accent plus a base, in dark or light mode. Rust creates
// the window and passes the theme as `?accent=<accent>&base=<base>`; anything not
// allowed falls back to the default. After a change in Settings (M2-007) the page
// swaps the attributes itself. tokens.css styles the allowed pairs through
// `data-accent`, `data-base`, and `data-mode`.
export type Accent = "orange" | "mint";
export type Base = "warm" | "cool" | "graphite";

export interface Theme {
  accent: Accent;
  base: Base;
}

/** The allowed pairs; tokens.test.ts checks the contrast of each. */
export const themes: readonly (readonly [Accent, Base])[] = [
  ["orange", "warm"],
  ["orange", "graphite"],
  ["mint", "cool"],
  ["mint", "graphite"],
];

export const defaultTheme: Theme = { accent: "orange", base: "warm" };

export function themeFrom(search: string): Theme {
  const params = new URLSearchParams(search);
  const accent = params.get("accent");
  const base = params.get("base");
  const allowed = themes.find(([a, b]) => a === accent && b === base);
  return allowed ? { accent: allowed[0], base: allowed[1] } : defaultTheme;
}

/** The accent and base of a theme chosen in Settings; the same pairs as Rust's. */
export function themeOf(choice: ThemeChoice): Theme {
  switch (choice) {
    case "orange":
      return { accent: "orange", base: "warm" };
    case "orange-graphite":
      return { accent: "orange", base: "graphite" };
    case "mint":
      return { accent: "mint", base: "cool" };
    case "mint-graphite":
      return { accent: "mint", base: "graphite" };
  }
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.accent = theme.accent;
  root.dataset.base = theme.base;
}

/**
 * Dark or light. Rust sets the window theme from the settings or Windows, and
 * WebView2 reports it as the preferred color scheme, also when Windows changes it.
 */
export type Mode = "dark" | "light";

/** Every mode exists for every allowed pair; tokens.test.ts checks all of them. */
export const modes: readonly Mode[] = ["dark", "light"];

type ColorSchemeQuery = Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
>;

/** Sets `data-mode` now and on every change; returns a function that stops following. */
export function followMode(
  root: HTMLElement,
  light: ColorSchemeQuery = window.matchMedia("(prefers-color-scheme: light)"),
): () => void {
  const apply = () => {
    root.dataset.mode = light.matches ? "light" : "dark";
  };
  apply();
  light.addEventListener("change", apply);
  return () => {
    light.removeEventListener("change", apply);
  };
}

/** The same icon Rust gives the window, so the title row matches the taskbar. */
export function appIconFor(theme: Theme): string {
  return theme.accent === "mint" ? "/favicon-mint.ico" : "/favicon.ico";
}
