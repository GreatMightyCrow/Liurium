import { type LucideIcon, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation } from "wouter";
import styles from "./Sidebar.module.css";
import { Tooltip } from "./Tooltip";

export interface SidebarItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

interface SidebarProps {
  title: string;
  items: readonly SidebarItem[];
  /** Items pinned to the bottom, e.g. settings. */
  endItems: readonly SidebarItem[];
  /** Only the icons show; names are tooltips (M3-014). */
  collapsed?: boolean;
  /** Collapses or expands; without it there is no button. */
  onToggle?: (collapsed: boolean) => void;
}

export function Sidebar({
  title,
  items,
  endItems,
  collapsed = false,
  onToggle,
}: SidebarProps) {
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className={styles.sidebar} data-collapsed={collapsed ? "" : undefined}>
      <div className={styles.header}>
        {!collapsed && <span className={styles.title}>{title}</span>}
        {onToggle !== undefined && (
          <Tooltip label={toggleLabel}>
            <button
              type="button"
              className={styles.toggle}
              aria-label={toggleLabel}
              onClick={() => {
                onToggle(!collapsed);
              }}
            >
              <ToggleIcon
                className={styles.toggleIcon}
                strokeWidth={1.5}
                aria-hidden
              />
            </button>
          </Tooltip>
        )}
      </div>
      <ul className={styles.list}>
        {items.map((item) => (
          <SidebarLink key={item.path} item={item} collapsed={collapsed} />
        ))}
      </ul>
      <ul className={`${styles.list} ${styles.end}`}>
        {endItems.map((item) => (
          <SidebarLink key={item.path} item={item} collapsed={collapsed} />
        ))}
      </ul>
    </div>
  );
}

function SidebarLink({
  item,
  collapsed,
}: {
  item: SidebarItem;
  collapsed: boolean;
}) {
  const [location] = useLocation();
  // Pages below an area, such as an open note, keep the area current.
  const isCurrent =
    location === item.path ||
    (item.path !== "/" && location.startsWith(`${item.path}/`));
  const Icon = item.icon;
  const link = (
    <Link
      href={item.path}
      replace={isCurrent}
      className={styles.link}
      aria-current={isCurrent ? "page" : undefined}
    >
      <Icon className={styles.icon} strokeWidth={1.5} aria-hidden />
      {/* Collapsed, the name stays for screen readers and shows as a tooltip. */}
      <span className={collapsed ? styles.hiddenLabel : undefined}>
        {item.label}
      </span>
    </Link>
  );
  return (
    // Re-choosing the current page replaces the entry, so Back never lands on the same page.
    <li>{collapsed ? <Tooltip label={item.label}>{link}</Tooltip> : link}</li>
  );
}
