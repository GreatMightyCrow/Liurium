import { expect, test } from "vitest";

const stylesheets = import.meta.glob<string>("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

// WebView2 computes `app-region: var(...)` as `none` even when the variable holds
// `drag` (found in M1-009), so drag areas would silently stop working.
test.each(Object.entries(stylesheets))(
  "%s sets app-region without CSS variables",
  (_path, css) => {
    expect(css).not.toMatch(/app-region\s*:\s*var\(/);
  },
);
