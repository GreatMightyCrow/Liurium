import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Button } from "./Button";
import {
  NotificationProvider,
  useNotify,
  type Notification,
} from "./Notifications";
import { TooltipProvider } from "./Tooltip";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function Trigger({ notification }: { notification: Notification }) {
  const notify = useNotify();
  return (
    <Button
      onClick={() => {
        notify(notification);
      }}
    >
      Notify
    </Button>
  );
}

function renderWith(notification: Notification) {
  render(
    <TooltipProvider>
      <NotificationProvider>
        <Trigger notification={notification} />
      </NotificationProvider>
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
}

function notifications(): HTMLElement {
  return screen.getByRole("region", { name: "Notifications" });
}

function waitMs(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

test("a confirmation shows its title and text, then closes by itself", () => {
  renderWith({
    tone: "success",
    title: "Note saved",
    description: "Meeting notes.md",
  });
  expect(within(notifications()).getByText("Note saved")).toBeDefined();
  expect(within(notifications()).getByText("Meeting notes.md")).toBeDefined();
  waitMs(4000);
  expect(screen.queryByText("Note saved")).not.toBeNull();
  waitMs(2000);
  expect(screen.queryByText("Note saved")).toBeNull();
});

test("an error is announced at once and stays until it is dismissed", () => {
  renderWith({ tone: "error", title: "Could not save the note" });
  // Base UI reads urgent notifications out through a hidden alert copy.
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not save the note",
  );
  waitMs(60_000);
  expect(
    within(notifications()).getByText("Could not save the note"),
  ).toBeDefined();

  // F6 moves focus into the notifications; the dismiss button is then reachable.
  fireEvent.keyDown(window, { key: "F6" });
  fireEvent.click(
    within(notifications()).getByRole("button", {
      name: "Dismiss notification",
    }),
  );
  waitMs(1000);
  expect(screen.queryByText("Could not save the note")).toBeNull();
});
