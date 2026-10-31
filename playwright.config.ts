import { defineConfig } from "@playwright/test";

// End-to-end tests against the release build (ADR-0019). One app at a time:
// every run shares the app data folder and the debugging port.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
});
