import {
  FileText,
  Folder,
  LayoutDashboard,
  ListChecks,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface Area {
  path: string;
  label: string;
  icon: LucideIcon;
  /** What the page will hold; shown until the area is built. */
  summary: string;
  /** "end" areas sit at the bottom of the sidebar. */
  placement: "main" | "end";
}

// The app's main areas (ADR-0014). Paths are defined here only; the sidebar and
// the routes both read them from this list.
export const areas: readonly Area[] = [
  {
    path: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    summary:
      "Not built yet. This page will show widgets for your projects, tasks, and recent notes.",
    placement: "main",
  },
  {
    path: "/projects",
    label: "Projects",
    icon: Folder,
    summary:
      "Not built yet. This page will list your projects and let you create and open them.",
    placement: "main",
  },
  {
    path: "/notes",
    label: "Notes",
    icon: FileText,
    summary:
      "Not built yet. This page will show the Markdown notes of the open project.",
    placement: "main",
  },
  {
    path: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    summary:
      "Not built yet. This page will show the Kanban board of the open project.",
    placement: "main",
  },
  {
    path: "/search",
    label: "Search",
    icon: Search,
    summary: "Not built yet. This page will search across projects and notes.",
    placement: "main",
  },
  {
    path: "/settings",
    label: "Settings",
    icon: Settings,
    summary: "Not built yet. This page will hold the application settings.",
    placement: "end",
  },
];
