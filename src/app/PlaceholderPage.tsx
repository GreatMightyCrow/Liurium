import { PageHeader } from "../ui/PageHeader";
import styles from "./PlaceholderPage.module.css";

interface PlaceholderPageProps {
  title: string;
  summary: string;
}

// Stands in for an area until its feature ticket builds the real page.
export function PlaceholderPage({ title, summary }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} />
      <p className={styles.summary}>{summary}</p>
    </>
  );
}
