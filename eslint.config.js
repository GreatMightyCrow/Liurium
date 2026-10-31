import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "src-tauri", "Vault", "Liurium_Brand_Assets"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // React code only; Playwright fixtures also take a function named `use`.
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Architecture Overview: only the IPC client talks to Tauri.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/ipc/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/api", "@tauri-apps/api/*"],
              message: "Only src/lib/ipc may import the Tauri API.",
            },
          ],
        },
      ],
    },
  },
]);
