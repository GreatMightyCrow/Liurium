import type { DataStatus } from "../lib/ipc/commands";
import { Card } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";
import { ErrorState, LoadingState } from "../ui/StateView";
import { commandErrorMessage } from "./commandErrorMessage";
import styles from "./SettingsPage.module.css";
import { useAppInfo } from "./useAppInfo";

// Settings arrive with M2-007; until then the page shows what Liurium reports
// about itself.
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className={styles.content}>
        <About />
      </div>
    </>
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
