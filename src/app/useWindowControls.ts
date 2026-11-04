import { useEffect, useState } from "react";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from "../lib/ipc/window";
import { flushOpenNote } from "./notes/useOpenNote";

function report(error: unknown) {
  console.error("window action failed", error);
}

// State and actions for the window buttons of the custom frames. The maximized
// state is re-read whenever the page resizes, which covers the button, a
// double-click on the drag area, and Windows shortcuts alike.
export function useWindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    const update = () => {
      isWindowMaximized()
        .then((value) => {
          if (active) {
            setMaximized(value);
          }
        })
        .catch(report);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      active = false;
      window.removeEventListener("resize", update);
    };
  }, []);

  return {
    maximized,
    minimize: () => {
      minimizeWindow().catch(report);
    },
    toggleMaximize: () => {
      toggleMaximizeWindow().catch(report);
    },
    // The open note's last text goes to Rust first; Rust saves it while closing
    // (M3-003) and asks only if that fails.
    close: () => {
      flushOpenNote()
        .catch(report)
        .then(() => closeWindow())
        .catch(report);
    },
  };
}
