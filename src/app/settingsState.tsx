import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
import {
  getSettings,
  type Settings,
  type SettingsView,
  updateSettings,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { commandErrorMessage } from "./commandErrorMessage";
import { useShowTheme } from "./showTheme";
import { themeOf } from "./theme";
import { listenForZoom, nextZoom, type ZoomDirection } from "./zoom";

export type LoadedSettings =
  | { status: "loading" }
  | { status: "ready"; view: SettingsView }
  | { status: "failed"; error: CommandError };

export interface SettingsState {
  loaded: LoadedSettings;
  /** What the page shows: the saved settings, or a change on its way to Rust. */
  shown: Settings | null;
  /** Why the last change could not be saved. */
  problem: string | null;
  change: (next: Partial<Settings>) => void;
}

const Context = createContext<SettingsState | null>(null);

export function useSettings(): SettingsState {
  const state = useContext(Context);
  if (state === null) {
    throw new Error("useSettings needs a SettingsProvider");
  }
  return state;
}

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

// The settings for the whole app (M2-007, M3-009): read once at start, changed by the
// Settings page and by the zoom keys. Each change is saved at once; Rust applies it to
// the window, the page swaps the theme attributes.
export function SettingsProvider({ children }: { children: ReactNode }) {
  const showTheme = useShowTheme();
  const [location, navigate] = useLocation();
  const startLocation = useRef(location);
  const [loaded, setLoaded] = useState<LoadedSettings>({ status: "loading" });
  const [shown, setShown] = useState<Settings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Only the answer to the latest change counts; arrow keys can send several.
  const latest = useRef(0);
  // The zoom keys read the newest value without waiting for a render.
  const current = useRef<{ shown: Settings | null; view: SettingsView | null }>(
    { shown: null, view: null },
  );

  useEffect(() => {
    let active = true;
    getSettings().then(
      (view) => {
        if (!active) {
          return;
        }
        current.current = { shown: view.settings, view };
        setLoaded({ status: "ready", view });
        setShown(view.settings);
        // "Show the project list" at start: only when nothing else was asked for.
        if (
          view.settings.startup === "projectList" &&
          startLocation.current === "/"
        ) {
          navigate("/projects", { replace: true });
        }
      },
      (reason: unknown) => {
        if (active) {
          setLoaded({ status: "failed", error: errorOf(reason) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [navigate]);

  const change = useCallback(
    (next: Partial<Settings>) => {
      const { shown: before, view: saved } = current.current;
      if (before === null || saved === null) {
        return;
      }
      const wanted = { ...before, ...next };
      latest.current += 1;
      const ticket = latest.current;
      current.current = { shown: wanted, view: saved };
      setShown(wanted);
      setProblem(null);
      updateSettings(wanted).then(
        (view) => {
          if (ticket === latest.current) {
            current.current = { shown: view.settings, view };
            setLoaded({ status: "ready", view });
            setShown(view.settings);
            showTheme(themeOf(view.settings.theme));
          }
        },
        (reason: unknown) => {
          if (ticket === latest.current) {
            current.current = { shown: saved.settings, view: saved };
            setShown(saved.settings);
            setProblem(
              `The change could not be saved. ${commandErrorMessage(errorOf(reason))}`,
            );
          }
        },
      );
    },
    [showTheme],
  );

  useEffect(
    () =>
      listenForZoom(window, (direction: ZoomDirection) => {
        const { shown: now, view } = current.current;
        if (now === null || view === null) {
          return;
        }
        const zoom = nextZoom(view.zoomSteps, now.zoom, direction);
        if (zoom !== now.zoom) {
          change({ zoom });
        }
      }),
    [change],
  );

  const value = useMemo(
    () => ({ loaded, shown, problem, change }),
    [loaded, shown, problem, change],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
