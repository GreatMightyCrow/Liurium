import { Folder } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  addProject,
  type CurrentProject,
  getCurrentProject,
  type ProjectInfo,
} from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./ProjectsPage.module.css";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; current: CurrentProject }
  | { status: "failed"; error: CommandError };

function errorOf(reason: unknown): CommandError {
  return reason instanceof CommandFailure ? reason.error : { kind: "internal" };
}

// The open project and "Add project folder". The list of all projects comes with
// M2-006; until then the last opened project is the one shown.
export function ProjectsPage() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<CommandError | null>(null);

  useEffect(() => {
    let current = true;
    getCurrentProject().then(
      (project) => {
        if (current) {
          setLoaded({ status: "ready", current: project });
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

  function add() {
    setAdding(true);
    setAddError(null);
    addProject()
      .then(
        (project) => {
          if (project !== null) {
            setLoaded({ status: "ready", current: { state: "open", project } });
          }
        },
        (reason: unknown) => {
          setAddError(errorOf(reason));
        },
      )
      .finally(() => {
        setAdding(false);
      });
  }

  const addButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} onClick={add} disabled={adding}>
      {adding ? "Adding…" : "Add project folder"}
    </Button>
  );

  return (
    <>
      <PageHeader title="Projects" />
      <div className={styles.content}>
        <Body loaded={loaded} addButton={addButton} />
        {addError !== null && (
          <p role="alert" className={styles.addError}>
            The folder could not be added. {commandErrorMessage(addError)}
          </p>
        )}
      </div>
    </>
  );
}

interface BodyProps {
  loaded: Loaded;
  addButton: (variant: "primary" | "secondary") => ReactNode;
}

function Body({ loaded, addButton }: BodyProps) {
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
  const current = loaded.current;
  switch (current.state) {
    case "none":
      return (
        <EmptyState
          icon={Folder}
          title="No project yet"
          description="Add a folder to keep its notes and tasks in Liurium. Liurium adds a .liurium folder to it and changes nothing else."
          action={addButton("primary")}
        />
      );
    case "unavailable":
      return (
        <ErrorState
          title={`“${current.name}” could not be opened`}
          description={commandErrorMessage(current.error)}
          action={addButton("secondary")}
        />
      );
    case "open":
      return <OpenProject project={current.project} addButton={addButton} />;
  }
}

interface OpenProjectProps {
  project: ProjectInfo;
  addButton: BodyProps["addButton"];
}

function OpenProject({ project, addButton }: OpenProjectProps) {
  return (
    <>
      <Card title={project.name}>
        <dl className={styles.facts}>
          <dt>Folder</dt>
          <dd className={styles.folder}>{project.folder}</dd>
        </dl>
        {project.readOnly && (
          <p className={styles.notice}>
            This folder is write-protected. Liurium shows the project but saves
            nothing to it.
          </p>
        )}
      </Card>
      <div>{addButton("secondary")}</div>
    </>
  );
}
