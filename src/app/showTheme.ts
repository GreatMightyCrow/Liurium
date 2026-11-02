import { createContext, useContext } from "react";
import { applyTheme, type Theme } from "./theme";

/**
 * Shows another theme in the running page after Rust saved it (M2-007). `App`
 * also swaps the title-row icon; without `App` (tests) only the attributes change.
 */
export const ShowTheme = createContext<(theme: Theme) => void>((theme) => {
  applyTheme(document.documentElement, theme);
});

export function useShowTheme(): (theme: Theme) => void {
  return useContext(ShowTheme);
}
