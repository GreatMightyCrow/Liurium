import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { AppShell } from "./AppShell";

test("places sidebar, content, and status bar in their landmarks", () => {
  render(
    <AppShell sidebar={<p>Sidebar item</p>} statusBar={<p>Status text</p>}>
      <p>Page content</p>
    </AppShell>,
  );

  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(within(navigation).getByText("Sidebar item")).toBeDefined();

  const main = screen.getByRole("main");
  expect(within(main).getByText("Page content")).toBeDefined();

  const statusBar = screen.getByRole("contentinfo", { name: "Status bar" });
  expect(within(statusBar).getByText("Status text")).toBeDefined();
});
