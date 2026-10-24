import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // Vitest blanks all CSS by default, including `?raw` imports. The style
    // tests read stylesheets as raw text, so let only those requests through.
    css: { include: [/\.css\?raw$/] },
    // The module cache keys a test file by its own content, so an
    // `import.meta.glob` keeps returning the files that existed when it was
    // cached. New stylesheets would then escape the raw-value check.
    fsModuleCache: false,
  },
}));
