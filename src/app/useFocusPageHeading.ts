import { useEffect, useRef } from "react";

// After a page change, focus moves to the new page's heading, so keyboard and
// screen reader users land on the page they chose. The first render is the app
// start: focus stays where Windows put it. A page without a heading (the error
// state) leaves focus alone; its alert is read out anyway.
export function useFocusPageHeading(location: string) {
  const shownLocation = useRef(location);
  useEffect(() => {
    if (shownLocation.current === location) {
      return;
    }
    shownLocation.current = location;
    document.querySelector<HTMLElement>("main h1")?.focus();
  }, [location]);
}
