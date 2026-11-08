import { useEffect, useRef } from "react";
import { useLocation } from "wouter";

// Ctrl + Shift + F and the sidebar's Search open the Notes page's Search tab
// (M4-002). A request made before the Notes page is there waits for it.

const EVENT = "liurium:search";
let pending = false;

export function requestSearch(): void {
  pending = true;
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `open` once for each request, also one made before this mounted. */
export function useSearchRequest(open: () => void): void {
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  });
  useEffect(() => {
    const take = () => {
      if (pending) {
        pending = false;
        latest.current();
      }
    };
    take();
    window.addEventListener(EVENT, take);
    return () => {
      window.removeEventListener(EVENT, take);
    };
  }, []);
}

type Keys = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/** Ctrl + Shift + F, as in Obsidian and VS Code; Ctrl + F stays for the note. */
export function isSearchShortcut(event: Keys): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "f"
  );
}

/** Listens for the shortcut on the whole page; the open note stays open. */
export function useSearchShortcut(): void {
  const [location, navigate] = useLocation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) {
        return;
      }
      event.preventDefault();
      requestSearch();
      if (location !== "/notes" && !location.startsWith("/notes/")) {
        navigate("/notes");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [location, navigate]);
}
