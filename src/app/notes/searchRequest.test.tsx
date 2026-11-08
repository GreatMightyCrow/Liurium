import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  isSearchShortcut,
  requestSearch,
  useSearchRequest,
  useSearchShortcut,
} from "./searchRequest";

const keys = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

test("only Ctrl + Shift + F is the shortcut", () => {
  expect(isSearchShortcut(keys("F", { ctrlKey: true, shiftKey: true }))).toBe(
    true,
  );
  expect(isSearchShortcut(keys("f", { ctrlKey: true, shiftKey: true }))).toBe(
    true,
  );
  expect(isSearchShortcut(keys("f", { ctrlKey: true }))).toBe(false);
  // AltGr comes as Ctrl + Alt and types characters.
  expect(
    isSearchShortcut(
      keys("F", { ctrlKey: true, shiftKey: true, altKey: true }),
    ),
  ).toBe(false);
  expect(isSearchShortcut(keys("F", { shiftKey: true }))).toBe(false);
});

function Listener({ onOpen }: { onOpen: () => void }) {
  useSearchRequest(onOpen);
  return null;
}

test("a request made before the page is there is taken once it mounts", () => {
  const onOpen = vi.fn();
  requestSearch();

  const { unmount } = render(<Listener onOpen={onOpen} />);
  expect(onOpen).toHaveBeenCalledTimes(1);
  unmount();

  render(<Listener onOpen={onOpen} />);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("a request while the page is there is taken at once", () => {
  const onOpen = vi.fn();
  render(<Listener onOpen={onOpen} />);

  act(() => {
    requestSearch();
  });

  expect(onOpen).toHaveBeenCalledTimes(1);
});

function Shortcut() {
  useSearchShortcut();
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
}

function press(mods: Partial<KeyboardEvent>) {
  const event = new KeyboardEvent("keydown", {
    key: "F",
    cancelable: true,
    ...mods,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

test("the shortcut leads to Notes, and keeps an open note open", () => {
  const onOpen = vi.fn();
  const { hook, navigate } = memoryLocation({ path: "/projects" });
  const { getByTestId } = render(
    <Router hook={hook}>
      <Shortcut />
      <Listener onOpen={onOpen} />
    </Router>,
  );

  const event = press({ ctrlKey: true, shiftKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(getByTestId("location").textContent).toBe("/notes");
  expect(onOpen).toHaveBeenCalledTimes(1);

  act(() => {
    navigate("/notes/Ideas/Plan.md");
  });
  press({ ctrlKey: true, shiftKey: true });
  expect(getByTestId("location").textContent).toBe("/notes/Ideas/Plan.md");
  expect(onOpen).toHaveBeenCalledTimes(2);

  expect(press({ ctrlKey: true }).defaultPrevented).toBe(false);
});
