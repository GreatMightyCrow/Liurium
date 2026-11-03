import { Ellipsis, Folder, FolderOpen, FolderX } from "lucide-react";
import {
  type SubmitEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  addProject,
  type CurrentProject,
  getCurrentProject,
  listProjects,
  locateProject,
  openProject,
  type ProjectEntry,
  removeProject,
  renameProject,
  type SyncTool,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { Dialog, DialogClose } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { TextField } from "../ui/TextField";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./ProjectsPage.module.css";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; projects: ProjectEntry[]; current: CurrentProject }
  | { status: "failed"; error: CommandError };

/** A failed action, shown below the project it belongs to, or below the list. */
interface Problem {
  id: string | null;
  text: string;
}

/** The dialog stays mounted after it closes, so Base UI moves focus only once the
 *  page shows the new list (the button for `finalFocus` may be a new one). */
interface Asking {
  action: "rename" | "remove";
  project: ProjectEntry;
  open: boolean;
  /** New for each question, so a dialog starts fresh. */
  key: number;
}

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

function failed(id: string | null, intro: string, reason: unknown): Problem {
  return { id, text: `${intro} ${commandErrorMessage(errorOf(reason))}` };
}

const openedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// All known projects, the most recently opened first. Clicking a name opens the
// project; a moved folder can be located again; the rest is in each row's menu.
export function ProjectsPage() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [working, setWorking] = useState<"add" | "other" | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const asked = useRef(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const busy = working !== null;

  const ask = (action: Asking["action"], project: ProjectEntry) => {
    asked.current += 1;
    setAsking({ action, project, open: true, key: asked.current });
  };
  const closeDialog = () => {
    setAsking((last) => (last === null ? null : { ...last, open: false }));
  };

  const load = useCallback(
    (): Promise<Loaded> =>
      Promise.all([listProjects(), getCurrentProject()]).then(
        ([projects, current]) => ({ status: "ready", projects, current }),
        (reason: unknown) => ({ status: "failed", error: errorOf(reason) }),
      ),
    [],
  );

  useEffect(() => {
    let current = true;
    void load().then((next) => {
      if (current) {
        setLoaded(next);
      }
    });
    return () => {
      current = false;
    };
  }, [load]);

  // Runs one action at a time, then shows the list as Rust now has it. A dialog
  // closes only together with the new list, when the button that takes focus
  // back is enabled again.
  function run(
    action: () => Promise<unknown>,
    onError: (reason: unknown) => void,
    kind: "add" | "other" = "other",
  ) {
    setWorking(kind);
    setProblem(null);
    void action()
      .catch(onError)
      .then(load)
      .then((next) => {
        setLoaded(next);
        setWorking(null);
        closeDialog();
      });
  }

  const add = () => {
    run(
      addProject,
      (reason) => {
        setProblem(failed(null, "The folder could not be added.", reason));
      },
      "add",
    );
  };

  const open = (project: ProjectEntry) => {
    run(
      () => openProject(project.id),
      (reason) => {
        setProblem(
          failed(project.id, `“${project.name}” could not be opened.`, reason),
        );
      },
    );
  };

  const locate = (project: ProjectEntry) => {
    run(
      () => locateProject(project.id),
      (reason) => {
        setProblem(
          failed(
            project.id,
            `The folder could not be used for “${project.name}”.`,
            reason,
          ),
        );
      },
    );
  };

  const remove = (project: ProjectEntry) => {
    run(
      () => removeProject(project.id),
      (reason) => {
        setProblem(
          failed(
            project.id,
            `“${project.name}” could not be removed from the list.`,
            reason,
          ),
        );
      },
    );
  };

  const renamed = () => {
    void load().then((next) => {
      setLoaded(next);
      closeDialog();
    });
  };

  const addButton = (variant: "primary" | "secondary") => (
    <Button ref={addRef} variant={variant} onClick={add} disabled={busy}>
      {working === "add" ? "Adding…" : "Add project folder"}
    </Button>
  );

  return (
    <>
      <PageHeader title="Projects" />
      <div className={styles.content}>
        <Body
          loaded={loaded}
          busy={busy}
          problem={problem}
          addButton={addButton}
          actions={{
            open,
            locate,
            rename: (project) => {
              ask("rename", project);
            },
            remove: (project) => {
              ask("remove", project);
            },
          }}
        />
        {problem?.id === null && (
          <p role="alert" className={styles.problem}>
            {problem.text}
          </p>
        )}
      </div>
      {asking?.action === "rename" && (
        <RenameDialog
          key={asking.key}
          project={asking.project}
          open={asking.open}
          onClose={closeDialog}
          onRenamed={renamed}
        />
      )}
      {asking?.action === "remove" && (
        <RemoveDialog
          key={asking.key}
          project={asking.project}
          open={asking.open}
          busy={busy}
          finalFocus={addRef}
          onClose={closeDialog}
          onConfirm={remove}
        />
      )}
    </>
  );
}

interface Actions {
  open: (project: ProjectEntry) => void;
  locate: (project: ProjectEntry) => void;
  rename: (project: ProjectEntry) => void;
  remove: (project: ProjectEntry) => void;
}

interface BodyProps {
  loaded: Loaded;
  busy: boolean;
  problem: Problem | null;
  addButton: (variant: "primary" | "secondary") => ReactNode;
  actions: Actions;
}

function Body({ loaded, busy, problem, addButton, actions }: BodyProps) {
  const baseId = useId();
  switch (loaded.status) {
    case "loading":
      return <LoadingState label="Loading projects…" />;
    case "failed":
      return (
        <ErrorState
          title="Projects could not be loaded"
          description={commandErrorMessage(loaded.error)}
        />
      );
    case "ready":
      break;
  }
  if (loaded.projects.length === 0) {
    return (
      <EmptyState
        icon={Folder}
        title="No project yet"
        description="Add a folder to keep its notes and tasks in Liurium. Liurium adds a .liurium folder to it and changes nothing else."
        action={addButton("primary")}
      />
    );
  }
  const { current } = loaded;
  const openOne = loaded.projects.find((project) => project.status === "open");
  const groups = grouped(
    loaded.projects.filter((project) => project.status !== "open"),
    new Date(),
  );
  const problemOf = (project: ProjectEntry) =>
    problem?.id === project.id ? problem.text : null;
  return (
    <>
      <div className={styles.toolbar}>{addButton("secondary")}</div>
      {current.state === "unavailable" && (
        <p role="alert" className={styles.problem}>
          “{current.name}” could not be opened when Liurium started.{" "}
          {commandErrorMessage(current.error)}
        </p>
      )}
      {openOne !== undefined && (
        <OpenProject
          project={openOne}
          readOnly={current.state === "open" && current.project.readOnly}
          syncedBy={current.state === "open" ? current.project.syncedBy : null}
          busy={busy}
          problem={problemOf(openOne)}
          actions={actions}
        />
      )}
      {groups.map((group) => {
        const titleId = `${baseId}-${group.key}`;
        return (
          <section key={group.key} className={styles.group}>
            <h2 id={titleId} className={styles.groupTitle}>
              {group.title}
            </h2>
            <ul className={styles.list} aria-labelledby={titleId}>
              {group.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  busy={busy}
                  problem={problemOf(project)}
                  actions={actions}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

interface Group {
  key: "today" | "week" | "earlier" | "never";
  title: string;
  projects: ProjectEntry[];
}

/** The projects by when they were last opened, in the order Rust sorted them. */
function grouped(projects: ProjectEntry[], now: Date): Group[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const groups: Group[] = [
    { key: "today", title: "Today", projects: [] },
    { key: "week", title: "This week", projects: [] },
    { key: "earlier", title: "Earlier", projects: [] },
    { key: "never", title: "Never opened", projects: [] },
  ];
  const [todays, weeks, earlier, never] = groups as [
    Group,
    Group,
    Group,
    Group,
  ];
  for (const project of projects) {
    if (project.lastOpenedAt === null) {
      never.projects.push(project);
      continue;
    }
    const opened = new Date(project.lastOpenedAt);
    if (opened >= today) {
      todays.projects.push(project);
    } else if (opened >= weekAgo) {
      weeks.projects.push(project);
    } else {
      earlier.projects.push(project);
    }
  }
  return groups.filter((group) => group.projects.length > 0);
}

interface OpenProjectProps {
  project: ProjectEntry;
  readOnly: boolean;
  /** Set only the first time the project is open in a sync folder (Rust decides). */
  syncedBy: SyncTool | null;
  busy: boolean;
  problem: string | null;
  actions: Actions;
}

const syncToolNames: Record<SyncTool, string> = {
  oneDrive: "OneDrive",
  dropbox: "Dropbox",
};

// The project Liurium has open, above the others.
function OpenProject({
  project,
  readOnly,
  syncedBy,
  busy,
  problem,
  actions,
}: OpenProjectProps) {
  const titleId = useId();
  return (
    <section className={styles.current} aria-labelledby={titleId}>
      <FolderOpen
        className={styles.currentIcon}
        strokeWidth={1.5}
        aria-hidden
      />
      <h2 id={titleId} className={styles.currentName}>
        {project.name}
      </h2>
      <FolderPath folder={project.folder} className={styles.currentPath} />
      <p className={styles.currentMeta}>
        <span className={styles.openLabel}>Open now</span>
        {project.lastOpenedAt !== null && (
          <span>
            Opened <When at={project.lastOpenedAt} />
          </span>
        )}
      </p>
      <div className={styles.currentActions}>
        <ProjectMenu project={project} busy={busy} actions={actions} />
      </div>
      {readOnly && (
        <p className={styles.currentNote}>
          Write-protected. Liurium shows the project but saves nothing to it.
        </p>
      )}
      {syncedBy !== null && (
        <p className={styles.currentNote}>
          {syncToolNames[syncedBy]} syncs this folder. Open the project on one
          computer at a time, or changes made on two at once can conflict.
        </p>
      )}
      {problem !== null && (
        <p role="alert" className={styles.currentNote}>
          {problem}
        </p>
      )}
    </section>
  );
}

interface ProjectRowProps {
  project: ProjectEntry;
  busy: boolean;
  problem: string | null;
  actions: Actions;
}

function ProjectRow({ project, busy, problem, actions }: ProjectRowProps) {
  const missing = project.status === "missing";
  // The icon shows the state; the words next to it say it too.
  const Icon = missing ? FolderX : Folder;
  return (
    <li className={styles.row} data-status={project.status}>
      <Icon className={styles.rowIcon} strokeWidth={1.5} aria-hidden />
      <div className={styles.label}>
        <h3 className={styles.name}>
          {missing ? (
            project.name
          ) : (
            <button
              type="button"
              className={styles.open}
              disabled={busy}
              onClick={() => {
                actions.open(project);
              }}
            >
              {project.name}
            </button>
          )}
        </h3>
        <FolderPath folder={project.folder} className={styles.path} />
        {missing && (
          <p className={styles.missing}>
            Folder not found
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                actions.locate(project);
              }}
            >
              Locate folder
            </Button>
          </p>
        )}
      </div>
      <p className={styles.when}>
        {!missing && project.lastOpenedAt !== null && (
          <When at={project.lastOpenedAt} />
        )}
      </p>
      <div className={styles.actions}>
        <ProjectMenu project={project} busy={busy} actions={actions} />
      </div>
      {problem !== null && (
        <p role="alert" className={styles.rowProblem}>
          {problem}
        </p>
      )}
    </li>
  );
}

interface ProjectMenuProps {
  project: ProjectEntry;
  busy: boolean;
  actions: Actions;
}

function ProjectMenu({ project, busy, actions }: ProjectMenuProps) {
  const missing = project.status === "missing";
  return (
    <Menu
      trigger={
        <IconButton
          icon={Ellipsis}
          label={`Actions for ${project.name}`}
          size="sm"
          disabled={busy}
        />
      }
    >
      {project.status === "available" && (
        <MenuItem
          onSelect={() => {
            actions.open(project);
          }}
        >
          Open
        </MenuItem>
      )}
      {missing ? (
        <MenuItem
          onSelect={() => {
            actions.locate(project);
          }}
        >
          Locate folder
        </MenuItem>
      ) : (
        <MenuItem
          onSelect={() => {
            actions.rename(project);
          }}
        >
          Rename…
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          actions.remove(project);
        }}
      >
        Remove from list…
      </MenuItem>
    </Menu>
  );
}

/** The folder path with its last part, the project folder, stressed. */
function FolderPath({
  folder,
  className,
}: {
  folder: string;
  className?: string;
}) {
  const cut = Math.max(folder.lastIndexOf("\\"), folder.lastIndexOf("/")) + 1;
  const leaf = folder.slice(cut);
  return (
    <p className={className} title={folder}>
      {leaf === "" ? (
        <span className={styles.leaf}>{folder}</span>
      ) : (
        <>
          {folder.slice(0, cut)}
          <span className={styles.leaf}>{leaf}</span>
        </>
      )}
    </p>
  );
}

// English words to match the UI; the tooltip gives the full date in the system format.
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (Math.abs(minutes) < 60) {
    return relative.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return relative.format(hours, "hour");
  }
  return relative.format(Math.round(hours / 24), "day");
}

function When({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at} title={openedAt.format(date)}>
      {ago(date, new Date())}
    </time>
  );
}

interface RenameDialogProps {
  project: ProjectEntry;
  open: boolean;
  onClose: () => void;
  onRenamed: () => void;
}

function RenameDialog({
  project,
  open,
  onClose,
  onRenamed,
}: RenameDialogProps) {
  const formId = useId();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function save(event: SubmitEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    renameProject(project.id, name).then(onRenamed, (reason: unknown) => {
      setError(commandErrorMessage(errorOf(reason)));
      setSaving(false);
    });
  }

  return (
    <Dialog
      open={open}
      title="Rename project"
      description="The name is saved in the project's .liurium folder, so it moves with the folder."
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={saving || name.trim() === ""}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save}>
        <TextField
          label="Name"
          value={name}
          error={error}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}

interface RemoveDialogProps {
  project: ProjectEntry;
  open: boolean;
  busy: boolean;
  finalFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: (project: ProjectEntry) => void;
}

function RemoveDialog({
  project,
  open,
  busy,
  finalFocus,
  onClose,
  onConfirm,
}: RemoveDialogProps) {
  return (
    <Dialog
      open={open}
      title={`Remove “${project.name}” from the list?`}
      description="The folder and everything in it stay as they are. Add the folder again to bring the project back."
      finalFocus={finalFocus}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      actions={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              onConfirm(project);
            }}
          >
            Remove from list
          </Button>
        </>
      }
    />
  );
}
