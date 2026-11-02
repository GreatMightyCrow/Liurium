import { Radio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { type ReactNode, useId } from "react";
import styles from "./RadioGroup.module.css";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** Shown before the label, hidden from screen readers (the label says it). */
  mark?: ReactNode;
}

interface RadioGroupProps<T extends string> {
  /** Names the group for screen readers and above the options. */
  label: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

// Arrow keys move between options and choose at once; Tab leaves the group.
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: RadioGroupProps<T>) {
  const labelId = useId();
  return (
    <div className={styles.group}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <BaseRadioGroup
        aria-labelledby={labelId}
        className={styles.options}
        value={value}
        onValueChange={(next: T) => {
          onChange(next);
        }}
        disabled={disabled}
      >
        {options.map((option) => (
          <label key={option.value} className={styles.option}>
            <Radio.Root value={option.value} className={styles.radio}>
              <Radio.Indicator className={styles.indicator} />
            </Radio.Root>
            {option.mark !== undefined && (
              <span className={styles.mark} aria-hidden="true">
                {option.mark}
              </span>
            )}
            {option.label}
          </label>
        ))}
      </BaseRadioGroup>
    </div>
  );
}
