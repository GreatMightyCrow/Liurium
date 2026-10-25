import type { ReactNode } from "react";
import styles from "./Card.module.css";

interface CardProps {
  title?: string;
  children: ReactNode;
}

// A bordered surface for grouped content. No shadow: cards sit in the page, they do not float.
export function Card({ title, children }: CardProps) {
  return (
    <div className={styles.card}>
      {title !== undefined && <h2 className={styles.title}>{title}</h2>}
      {children}
    </div>
  );
}
