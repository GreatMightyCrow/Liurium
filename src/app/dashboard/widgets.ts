import { RecentNotes } from "./RecentNotes";
import type { WidgetDefinition } from "./widget";

// The dashboard's widgets, in the order they show (a fixed grid, owner decision Q2).
// More follow in M4-006; choosing and ordering them is M4-007.
export const dashboardWidgets: readonly WidgetDefinition[] = [
  {
    id: "recentNotes",
    title: "Recent notes",
    size: "normal",
    Body: RecentNotes,
  },
];
