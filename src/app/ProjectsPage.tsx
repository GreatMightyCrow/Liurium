import { Ellipsis, Folder, TriangleAlert } from "lucide-react";
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
  return (
    <>
      <div className={styles.toolbar}>{addButton("secondary")}</div>
      {current.state === "unavailable" && (
        <p role="alert" className={styles.problem}>
          “{current.name}” could not be opened when Liurium started.{" "}
          {commandErrorMessage(current.error)}
        </p>
      )}
      {current.state === "open" && current.project.readOnly && (
        <p className={styles.notice}>
          “{current.project.name}” is write-protected. Liurium shows the project
          but saves nothing to it.
        </p>
      )}
      <ul className={styles.list} aria-label="Projects">
        {loaded.projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            busy={busy}
            problem={problem?.id === project.id ? problem.text : null}
            actions={actions}
          />
        ))}
      </ul>
    </>
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
  return (
    <li
      className={styles.row}
      data-status={project.status}
      aria-current={project.status === "open" ? "true" : undefined}
    >
      <h2 className={styles.name}>
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
      </h2>
      <p className={styles.folder}>{project.folder}</p>
      <p className={styles.meta}>
        <Status project={project} />
        <span className={styles.opened}>
          {project.lastOpenedAt === null ? (
            "Never opened"
          ) : (
            <>
              Opened{" "}
              <time dateTime={project.lastOpenedAt}>
                {openedAt.format(new Date(project.lastOpenedAt))}
              </time>
            </>
          )}
        </span>
      </p>
      <div className={styles.actions}>
        {missing && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              actions.locate(project);
            }}
          >
            Locate folder
          </Button>
        )}
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
      </div>
      {problem !== null && (
        <p role="alert" className={styles.rowProblem}>
          {problem}
        </p>
      )}
    </li>
  );
}

// In words, never by color alone. An available project needs no label.
function Status({ project }: { project: ProjectEntry }) {
  switch (project.status) {
    case "open":
      return <span className={styles.openLabel}>Open</span>;
    case "missing":
      return (
        <span className={styles.missingLabel}>
          <TriangleAlert
            className={styles.statusIcon}
            strokeWidth={1.5}
            aria-hidden
          />
          Folder not found
        </span>
      );
    case "available":
      return null;
  }
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
