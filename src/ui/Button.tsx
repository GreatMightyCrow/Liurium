import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<
  ComponentProps<typeof BaseButton>,
  "className"
> {
  /** primary: the one main action; secondary: default; ghost: quiet; danger: destructive. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      type={type}
      className={[styles.button, styles[variant], styles[size], className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
