import {
  HardDrive,
  Info,
  type LucideIcon,
  Minus,
  Palette,
  Plus,
  Power,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  type AppDataInfo,
  type DataStatus,
  type FrameStyle,
  getAppDataInfo,
  type Mode,
  openAppDataFolder,
  pruneBackups,
  resetSyncWarnings,
  restartApp,
  type SettingKey,
  type StartWith,
  type ThemeChoice,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { type ChoiceTile, ChoiceTiles } from "../ui/ChoiceTiles";
import { Dialog, DialogClose } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { PageHeader } from "../ui/PageHeader";
import { RadioGroup } from "../ui/RadioGroup";
import { ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./SettingsPage.module.css";
import { useSettings } from "./settingsState";
import { themeOf } from "./theme";
import { useAppInfo } from "./useAppInfo";
import { usePageMode, WindowPicture } from "./WindowPicture";
import { NORMAL_ZOOM, nextZoom } from "./zoom";

type SectionId = "appearance" | "startup" | "data" | "about";

const sections: readonly { id: SectionId; label: string; icon: LucideIcon }[] =
  [
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "startup", label: "Startup", icon: Power },
    { id: "data", label: "Data", icon: HardDrive },
    { id: "about", label: "About", icon: Info },
  ];

// Settings in sections (M3-009, owner's choice A): a list on the left, the chosen
// section on the right. Each choice is saved at once; there is no Save button.
export function SettingsPage() {
  const [section, setSection] = useState<SectionId>("appearance");
  return (
    <>
      <PageHeader title="Settings" />
      <div className={styles.layout}>
        <nav aria-label="Settings sections" className={styles.nav}>
          <ul className={styles.navList}>
            {sections.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  className={styles.navItem}
                  aria-current={id === section ? "true" : undefined}
                  onClick={() => {
                    setSection(id);
                  }}
                >
                  <Icon
                    className={styles.navIcon}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.pane}>
          {section === "appearance" && <Appearance />}
          {section === "startup" && <Startup />}
          {section === "data" && <Data />}
          {section === "about" && <About />}
        </div>
      </div>
    </>
  );
}

function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {title}
      </h2>
      {intro !== undefined && <p className={styles.intro}>{intro}</p>}
      <div className={styles.rows}>{children}</div>
    </section>
  );
}

/** One setting: its name and a line about it, the control at the end. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {hint !== undefined && <span className={styles.rowHint}>{hint}</span>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

const settingNames: Record<SettingKey, string> = {
  theme: "theme",
  mode: "mode",
  frame: "window frame",
  startup: "startup choice",
  zoom: "zoom",
};

const themeNames: Record<ThemeChoice, string> = {
  orange: "Orange",
  "orange-graphite": "Orange on graphite",
  mint: "Mint",
  "mint-graphite": "Mint on graphite",
};

const frameNames: Record<FrameStyle, string> = {
  liurium: "Liurium title bar",
  native: "Windows title bar",
  hidden: "No title bar",
};

/** The settings the sections change; shows loading, failure, and save problems. */
function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { loaded, shown, problem } = useSettings();
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
  const fellBack = loaded.view.fellBack;
  return (
    <Section title={title}>
      {fellBack.length > 0 && (
        <p className={styles.notice}>
          Liurium could not read the saved{" "}
          {fellBack.map((key) => settingNames[key]).join(" and ")} and uses the
          default. Choose again to save it.
        </p>
      )}
      {children}
      {problem !== null && (
        <p role="alert" className={styles.problem}>
          {problem}
        </p>
      )}
    </Section>
  );
}

function Appearance() {
  return (
    <SettingsSection title="Appearance">
      <AppearanceRows />
    </SettingsSection>
  );
}

function AppearanceRows() {
  const { loaded, shown, change } = useSettings();
  const pageMode = usePageMode();
  const [restarting, setRestarting] = useState(false);
  const [restartProblem, setRestartProblem] = useState<string | null>(null);
  if (loaded.status !== "ready" || shown === null) {
    return null;
  }
  const saved = loaded.view;
  const theme = themeOf(shown.theme);

  const themes: ChoiceTile<ThemeChoice>[] = (
    Object.keys(themeNames) as ThemeChoice[]
  ).map((choice) => ({
    value: choice,
    label: themeNames[choice],
    picture: <WindowPicture theme={themeOf(choice)} mode={pageMode} />,
  }));
  const modes: ChoiceTile<Mode>[] = [
    {
      value: "system",
      label: "Same as Windows",
      picture: <WindowPicture theme={theme} mode="light" splitWith="dark" />,
    },
    {
      value: "light",
      label: "Light",
      picture: <WindowPicture theme={theme} mode="light" />,
    },
    {
      value: "dark",
      label: "Dark",
      picture: <WindowPicture theme={theme} mode="dark" />,
    },
  ];
  const frames: ChoiceTile<FrameStyle>[] = (
    Object.keys(frameNames) as FrameStyle[]
  ).map((frame) => ({
    value: frame,
    label: frameNames[frame],
    picture: <WindowPicture theme={theme} mode={pageMode} frame={frame} />,
  }));

  const restart = () => {
    setRestarting(true);
    restartApp().catch((reason: unknown) => {
      setRestarting(false);
      setRestartProblem(
        `Liurium could not restart. ${commandErrorMessage(errorOf(reason))}`,
      );
    });
  };

  return (
    <>
      <div className={`${styles.row} ${styles.stacked}`}>
        <ChoiceTiles
          label="Theme"
          hint="Accent color and base. Changes at once."
          value={shown.theme}
          options={themes}
          onChange={(choice) => {
            change({ theme: choice });
          }}
        />
      </div>
      <div className={`${styles.row} ${styles.stacked}`}>
        <ChoiceTiles
          label="Mode"
          value={shown.mode}
          options={modes}
          onChange={(mode) => {
            change({ mode });
          }}
        />
      </div>
      <div className={`${styles.row} ${styles.stacked}`}>
        <ChoiceTiles
          label="Window frame"
          hint="Applies after Liurium restarts."
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
        {restartProblem !== null && (
          <p role="alert" className={styles.problem}>
            {restartProblem}
          </p>
        )}
      </div>
      <Row
        label="Zoom"
        hint={
          <>
            Size of text and controls. Also <kbd>Ctrl</kbd> + <kbd>Plus</kbd>,{" "}
            <kbd>Ctrl</kbd> + <kbd>Minus</kbd>, and <kbd>Ctrl</kbd> +{" "}
            <kbd>0</kbd>.
          </>
        }
      >
        <ZoomControl
          zoom={shown.zoom}
          steps={saved.zoomSteps}
          onChange={(zoom) => {
            change({ zoom });
          }}
        />
      </Row>
    </>
  );
}

function ZoomControl({
  zoom,
  steps,
  onChange,
}: {
  zoom: number;
  steps: readonly number[];
  onChange: (zoom: number) => void;
}) {
  const smaller = nextZoom(steps, zoom, "out");
  const larger = nextZoom(steps, zoom, "in");
  return (
    <div className={styles.zoom}>
      <IconButton
        icon={Minus}
        label="Zoom out"
        variant="secondary"
        disabled={smaller === zoom}
        onClick={() => {
          onChange(smaller);
        }}
      />
      {/* An output is a live region: the new size is read out after each step. */}
      <output className={styles.zoomValue} aria-label="Zoom">
        {zoom} %
      </output>
      <IconButton
        icon={Plus}
        label="Zoom in"
        variant="secondary"
        disabled={larger === zoom}
        onClick={() => {
          onChange(larger);
        }}
      />
      <Button
        variant="ghost"
        disabled={zoom === NORMAL_ZOOM}
        onClick={() => {
          onChange(NORMAL_ZOOM);
        }}
      >
        Reset
      </Button>
    </div>
  );
}

function Startup() {
  return (
    <SettingsSection title="Startup">
      <StartupRows />
    </SettingsSection>
  );
}

const startOptions: { value: StartWith; label: string }[] = [
  { value: "lastProject", label: "Open the last project" },
  { value: "projectList", label: "Show the project list" },
];

function StartupRows() {
  const { shown, change } = useSettings();
  if (shown === null) {
    return null;
  }
  return (
    <div className={`${styles.row} ${styles.stacked}`}>
      <RadioGroup
        label="When Liurium starts"
        value={shown.startup}
        options={startOptions}
        onChange={(startup) => {
          change({ startup });
        }}
      />
      <p className={styles.rowHint}>Applies at the next start.</p>
    </div>
  );
}

type LoadedData =
  | { status: "loading" }
  | { status: "ready"; info: AppDataInfo }
  | { status: "failed"; error: CommandError };

const sizes = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${sizes.format(bytes / 1024)} KB`;
  }
  return `${sizes.format(bytes / (1024 * 1024))} MB`;
}

function copies(count: number): string {
  return count === 1 ? "1 copy" : `${String(count)} copies`;
}

function Data() {
  const [loaded, setLoaded] = useState<LoadedData>({ status: "loading" });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let active = true;
    getAppDataInfo().then(
      (info) => {
        if (active) {
          setLoaded({ status: "ready", info });
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
  }, []);

  if (loaded.status === "failed") {
    return (
      <ErrorState
        title="App data could not be read"
        description={commandErrorMessage(loaded.error)}
      />
    );
  }
  if (loaded.status === "loading") {
    return <LoadingState label="Loading app data…" />;
  }
  const { info } = loaded;
  const removable = Math.max(0, info.backups - info.keptBackups);

  const run = (
    action: () => Promise<AppDataInfo | undefined>,
    intro: string,
    done: (info: AppDataInfo | undefined) => string | null,
  ) => {
    setWorking(true);
    setMessage(null);
    setProblem(null);
    action().then(
      (next) => {
        setWorking(false);
        if (next !== undefined) {
          setLoaded({ status: "ready", info: next });
        }
        setMessage(done(next));
      },
      (reason: unknown) => {
        setWorking(false);
        setProblem(`${intro} ${commandErrorMessage(errorOf(reason))}`);
      },
    );
  };

  return (
    <Section
      title="Data"
      intro="Liurium keeps your project list and settings here. Your notes stay in your project folders."
    >
      <Row
        label="App data folder"
        hint={<span className={styles.path}>{info.folder}</span>}
      >
        <Button
          disabled={working}
          onClick={() => {
            run(
              () => openAppDataFolder().then(() => undefined),
              "The folder could not be opened.",
              () => null,
            );
          }}
        >
          Open folder
        </Button>
      </Row>
      <Row
        label="Backups"
        hint={
          info.backups === 0
            ? "No backup copies yet. Liurium makes one before it updates its data."
            : `${copies(info.backups)}, ${sizeText(info.backupBytes)}. Liurium makes one before it updates its data; the newest ${String(info.keptBackups)} always stay.`
        }
      >
        {removable > 0 && (
          <Button
            disabled={working}
            onClick={() => {
              setAsking(true);
            }}
          >
            Delete{" "}
            {removable === 1
              ? "1 older copy"
              : `${String(removable)} older copies`}
            …
          </Button>
        )}
      </Row>
      <Row
        label="Sync folder warnings"
        hint={
          info.syncWarned === 0
            ? "Shown once for each project in a OneDrive or Dropbox folder. None was shown yet."
            : `Shown once for each project in a OneDrive or Dropbox folder. ${info.syncWarned === 1 ? "1 project has" : `${String(info.syncWarned)} projects have`} shown it.`
        }
      >
        <Button
          disabled={working || info.syncWarned === 0}
          onClick={() => {
            run(
              resetSyncWarnings,
              "The warnings could not be reset.",
              () => "Each project warns again the next time it opens.",
            );
          }}
        >
          Warn again
        </Button>
      </Row>
      {message !== null && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className={styles.problem}>
          {problem}
        </p>
      )}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${removable === 1 ? "1 older backup copy" : `${String(removable)} older backup copies`}?`}
        description={`The newest ${String(info.keptBackups)} copies stay. Your projects and notes are not affected.`}
        actions={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                run(
                  pruneBackups,
                  "The backup copies could not be deleted.",
                  (next) =>
                    next === undefined
                      ? null
                      : `Deleted ${copies(info.backups - next.backups)}.`,
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </Section>
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
        <Section title="About Liurium">
          <dl className={styles.facts}>
            <dt>Version</dt>
            <dd>{state.info.version}</dd>
            <dt>App data</dt>
            <dd>{dataStatusText(state.info.data)}</dd>
            <dt>License</dt>
            <dd>GPL-3.0-only</dd>
          </dl>
        </Section>
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
