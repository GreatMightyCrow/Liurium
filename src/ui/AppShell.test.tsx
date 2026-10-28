import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { FrameStyle } from "../app/frameStyle";
import { AppShell } from "./AppShell";

function renderShell(frame: FrameStyle) {
  return render(
    <AppShell
      frame={frame}
      title="Liurium"
      icon="/favicon-mint.ico"
      windowControls={<button type="button">Close</button>}
      sidebar={<p>Sidebar item</p>}
      statusBar={<p>Status text</p>}
    >
      <p>Page content</p>
    </AppShell>,
  );
}

test("places sidebar, content, and status bar in their landmarks", () => {
  renderShell("native");

  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(within(navigation).getByText("Sidebar item")).toBeDefined();

  const main = screen.getByRole("main");
  expect(within(main).getByText("Page content")).toBeDefined();

  const statusBar = screen.getByRole("contentinfo", { name: "Status bar" });
  expect(within(statusBar).getByText("Status text")).toBeDefined();
});

test("native frame leaves title bar and window buttons to Windows", () => {
  renderShell("native");
  expect(screen.queryByTestId("title-bar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

test("Liurium frame adds a title bar with the window buttons", () => {
  renderShell("liurium");
  expect(screen.getByTestId("title-bar").textContent).toContain("Liurium");
  expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
});

test("the title bar shows the given app icon", () => {
  renderShell("liurium");
  const icon = screen.getByTestId("title-bar").querySelector("img");
  expect(icon?.getAttribute("src")).toBe("/favicon-mint.ico");
});

test("hidden frame shows the window buttons without a title bar", () => {
  renderShell("hidden");
  expect(screen.queryByTestId("title-bar")).toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
});

test("window buttons come last in tab order, after the page", () => {
  const { container } = renderShell("liurium");
  const focusables = Array.from(container.querySelectorAll("button, a, main"));
  expect(focusables[focusables.length - 1].textContent).toBe("Close");
});
