import { useState } from "react";
import { PageHeader } from "../ui/PageHeader";
import styles from "./dashboard/Dashboard.module.css";
import { DashboardChanges, type WidgetDefinition } from "./dashboard/widget";
import { WidgetFrame } from "./dashboard/WidgetFrame";
import { dashboardWidgets } from "./dashboard/widgets";
import { useNoteChanges } from "./notes/useNoteChanges";

interface DashboardPageProps {
  /** Defaults to the app's widgets; tests pass their own. */
  widgets?: readonly WidgetDefinition[];
}

// The start page (M4-005): widgets in a fixed grid that follows the window's width.
// One wait for outside changes serves every widget.
export function DashboardPage({
  widgets = dashboardWidgets,
}: DashboardPageProps) {
  const [changes, setChanges] = useState(0);
  useNoteChanges(() => {
    setChanges((last) => last + 1);
  });
  return (
    <>
      <PageHeader title="Dashboard" />
      <DashboardChanges.Provider value={changes}>
        <div className={styles.grid}>
          {widgets.map((widget) => (
            <WidgetFrame key={widget.id} widget={widget} />
          ))}
        </div>
      </DashboardChanges.Provider>
    </>
  );
}
