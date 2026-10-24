import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  title: string;
}

// Top row of every page. Same height as the sidebar header so both edges line up.
export function PageHeader({ title }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
    </header>
  );
}
