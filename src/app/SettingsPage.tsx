import { useEffect, useRef, useState } from "react";
import {
  type DataStatus,
  type FrameStyle,
  getSettings,
  type Mode,
  restartApp,
  type SettingKey,
  type Settings,
  type SettingsView,
  type ThemeChoice,
  updateSettings,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";
import { type RadioOption, RadioGroup } from "../ui/RadioGroup";
import { ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./SettingsPage.module.css";
import { useShowTheme } from "./showTheme";
import { themeOf } from "./theme";
import { useAppInfo } from "./useAppInfo";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className={styles.content}>
        <Appearance />
        <About />
      </div>
    </>
  );
}

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

function swatch(accent: "orange" | "mint") {
  return <span className={styles.swatch} data-accent={accent} />;
}

const themes: readonly RadioOption<ThemeChoice>[] = [
  { value: "orange", label: "Orange", mark: swatch("orange") },
  {
    value: "orange-graphite",
    label: "Orange on graphite",
    mark: swatch("orange"),
  },
  { value: "mint", label: "Mint", mark: swatch("mint") },
  { value: "mint-graphite", label: "Mint on graphite", mark: swatch("mint") },
];

const modes: readonly RadioOption<Mode>[] = [
  { value: "system", label: "Same as Windows" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const frames: readonly RadioOption<FrameStyle>[] = [
  { value: "liurium", label: "Liurium title bar" },
  { value: "native", label: "Windows title bar" },
  { value: "hidden", label: "No title bar" },
];

const settingNames: Record<SettingKey, string> = {
  theme: "theme",
  mode: "mode",
  frame: "window frame",
};

type Loaded =
  | { status: "loading" }
  | { status: "ready"; view: SettingsView }
  | { status: "failed"; error: CommandError };

// Each choice is saved at once. Theme and mode change while Liurium runs; the window
// frame needs a restart.
function Appearance() {
  const showTheme = useShowTheme();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [shown, setShown] = useState<Settings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Only the answer to the latest change counts; arrow keys can send several.
  const latest = useRef(0);

  useEffect(() => {
    let current = true;
    getSettings().then(
      (view) => {
        if (current) {
          setLoaded({ status: "ready", view });
          setShown(view.settings);
        }
      },
      (reason: unknown) => {
        if (current) {
          setLoaded({ status: "failed", error: errorOf(reason) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (loaded.status === "failed") {
    return (
      <ErrorState
        title="Settings could not be loaded"
        description={commandErrorMessage(loaded.error)}
      />
    );
  }
  if (loaded.status === "loading" || shown === null) {
    return <LoadingState label="Loading settings…" />;
  }
  const saved = loaded.view;

  const change = (next: Partial<Settings>) => {
    const wanted = { ...shown, ...next };
    latest.current += 1;
    const ticket = latest.current;
    setShown(wanted);
    setProblem(null);
    updateSettings(wanted).then(
      (view) => {
        if (ticket === latest.current) {
          setLoaded({ status: "ready", view });
          setShown(view.settings);
          showTheme(themeOf(view.settings.theme));
        }
      },
      (reason: unknown) => {
        if (ticket === latest.current) {
          setShown(saved.settings);
          setProblem(
            `The change could not be saved. ${commandErrorMessage(errorOf(reason))}`,
          );
        }
      },
    );
  };

  const restart = () => {
    setRestarting(true);
    restartApp().catch((reason: unknown) => {
      setRestarting(false);
      setProblem(
        `Liurium could not restart. ${commandErrorMessage(errorOf(reason))}`,
      );
    });
  };

  return (
    <Card title="Appearance">
      {saved.fellBack.length > 0 && (
        <p className={styles.notice}>
          Liurium could not read the saved{" "}
          {saved.fellBack.map((key) => settingNames[key]).join(" and ")} and
          uses the default. Choose again to save it.
        </p>
      )}
      <RadioGroup
        label="Theme"
        value={shown.theme}
        options={themes}
        onChange={(theme) => {
          change({ theme });
        }}
      />
      <RadioGroup
        label="Mode"
        value={shown.mode}
        options={modes}
        onChange={(mode) => {
          change({ mode });
        }}
      />
      <RadioGroup
        label="Window frame"
        value={shown.frame}
        options={frames}
        onChange={(frame) => {
          change({ frame });
        }}
      />
      {saved.settings.frame !== saved.frameAtStart && (
        <div className={styles.restart}>
          <p className={styles.notice}>
            The new window frame applies after Liurium restarts.
          </p>
          <Button onClick={restart} disabled={restarting}>
            {restarting ? "Restarting…" : "Restart now"}
          </Button>
        </div>
      )}
      {problem !== null && (
        <p role="alert" className={styles.problem}>
          {problem}
        </p>
      )}
    </Card>
  );
}

function About() {
  const state = useAppInfo();
  switch (state.status) {
    case "loading":
      return <LoadingState label="Loading app information…" />;
    case "failed":
      return (
        <ErrorState
          title="App information could not be loaded"
          description={commandErrorMessage(state.error)}
        />
      );
    case "ready":
      return (
        <Card title="About Liurium">
          <dl className={styles.facts}>
            <dt>Version</dt>
            <dd>{state.info.version}</dd>
            <dt>App data</dt>
            <dd>{dataStatusText(state.info.data)}</dd>
          </dl>
        </Card>
      );
  }
}

export function dataStatusText(data: DataStatus): string {
  switch (data.state) {
    case "ready":
      return "Ready";
    case "recovered":
      return "The app data was damaged and has been replaced. Your notes are not affected; add your projects again.";
    case "failed":
      return commandErrorMessage(data.error);
  }
}
