// Color themes (ADR-0015): an accent plus a base. Rust creates the window and passes
// the theme as `?accent=<accent>&base=<base>`; anything not allowed falls back to the
// default. tokens.css styles the allowed pairs through `data-accent` and `data-base`.
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

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.accent = theme.accent;
  root.dataset.base = theme.base;
}

/** The same icon Rust gives the window, so the title row matches the taskbar. */
export function appIconFor(theme: Theme): string {
  return theme.accent === "mint" ? "/favicon-mint.ico" : "/favicon.ico";
}
