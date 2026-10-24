import { useEffect, useState } from "react";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from "../lib/ipc/window";

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
    close: () => {
      closeWindow().catch(report);
    },
  };
}
