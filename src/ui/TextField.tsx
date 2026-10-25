import { Field } from "@base-ui/react/field";
import type { ComponentProps } from "react";
import styles from "./TextField.module.css";

interface TextFieldProps extends Omit<
  ComponentProps<typeof Field.Control>,
  "className"
> {
  label: string;
  /** Help text below the input, linked to it for screen readers. */
  description?: string;
  /** Marks the field invalid and shows the message. */
  error?: string;
}

export function TextField({
  label,
  description,
  error,
  ...props
}: TextFieldProps) {
  return (
    <Field.Root className={styles.field} invalid={error !== undefined}>
      <Field.Label className={styles.label}>{label}</Field.Label>
      <Field.Control className={styles.input} {...props} />
      {description !== undefined && (
        <Field.Description className={styles.description}>
          {description}
        </Field.Description>
      )}
      {error !== undefined && (
        <Field.Error className={styles.error} match>
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}
