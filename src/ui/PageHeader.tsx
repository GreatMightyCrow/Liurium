import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  title: string;
}

// Top row of every page. Same height as the sidebar header so both edges line up.
// The heading takes focus after a page change (useFocusPageHeading), not by Tab.
export function PageHeader({ title }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title} tabIndex={-1}>
        {title}
      </h1>
    </header>
  );
}
