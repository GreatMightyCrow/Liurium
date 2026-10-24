import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { WindowControls } from "./WindowControls";

function renderControls(maximized: boolean) {
  const handlers = {
    onMinimize: vi.fn(),
    onToggleMaximize: vi.fn(),
    onClose: vi.fn(),
  };
  render(<WindowControls maximized={maximized} {...handlers} />);
  return handlers;
}

test("labels the buttons and calls the matching handler", () => {
  const handlers = renderControls(false);
  fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(handlers.onMinimize).toHaveBeenCalledOnce();
  expect(handlers.onToggleMaximize).toHaveBeenCalledOnce();
  expect(handlers.onClose).toHaveBeenCalledOnce();
});

test("offers Restore while the window is maximized", () => {
  renderControls(true);
  expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
});
