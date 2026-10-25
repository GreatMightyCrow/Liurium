import type { LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "./Button";
import styles from "./IconButton.module.css";
import { Tooltip } from "./Tooltip";

interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  icon: LucideIcon;
  /** Accessible name and tooltip text in one, so they can never differ. */
  label: string;
}

export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <Button
        aria-label={label}
        variant={variant}
        size={size}
        className={[styles.iconButton, styles[size], className]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        <Icon className={styles.icon} strokeWidth={1.5} aria-hidden />
      </Button>
    </Tooltip>
  );
}
