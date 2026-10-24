import type { LucideIcon } from "lucide-react";
import { Link, useRoute } from "wouter";
import styles from "./Sidebar.module.css";

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
}

export function Sidebar({ title, items, endItems }: SidebarProps) {
  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
      </div>
      <ul className={styles.list}>
        {items.map((item) => (
          <SidebarLink key={item.path} item={item} />
        ))}
      </ul>
      <ul className={`${styles.list} ${styles.end}`}>
        {endItems.map((item) => (
          <SidebarLink key={item.path} item={item} />
        ))}
      </ul>
    </div>
  );
}

function SidebarLink({ item }: { item: SidebarItem }) {
  const [isCurrent] = useRoute(item.path);
  const Icon = item.icon;
  return (
    <li>
      {/* Re-choosing the current page replaces the entry, so Back never lands on the same page. */}
      <Link
        href={item.path}
        replace={isCurrent}
        className={styles.link}
        aria-current={isCurrent ? "page" : undefined}
      >
        <Icon className={styles.icon} strokeWidth={1.5} aria-hidden />
        {item.label}
      </Link>
    </li>
  );
}
