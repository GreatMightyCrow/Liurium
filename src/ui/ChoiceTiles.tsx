import { Radio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import styles from "./ChoiceTiles.module.css";

export interface ChoiceTile<T extends string> {
  value: T;
  label: string;
  /** A picture of the choice, hidden from screen readers (the label says it). */
  picture: ReactNode;
}

interface ChoiceTilesProps<T extends string> {
  /** Names the group for screen readers and above the tiles. */
  label: string;
  /** A line below the label, linked to the group. */
  hint?: string;
  value: T;
  options: readonly ChoiceTile<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

// A radio group whose options are pictures with a name below (M3-009). Arrow keys move
// and choose like in `RadioGroup`; the chosen tile gets a ring and a check mark, so
// the choice never depends on color alone.
export function ChoiceTiles<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: ChoiceTilesProps<T>) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className={styles.group}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      {hint !== undefined && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      <BaseRadioGroup
        aria-labelledby={labelId}
        aria-describedby={hint === undefined ? undefined : hintId}
        className={styles.tiles}
        value={value}
        onValueChange={(next: T) => {
          onChange(next);
        }}
        disabled={disabled}
      >
        {options.map((option) => (
          <Radio.Root
            key={option.value}
            value={option.value}
            className={styles.tile}
          >
            <span className={styles.picture} aria-hidden="true">
              {option.picture}
            </span>
            <span className={styles.name}>
              <Check className={styles.check} strokeWidth={2} aria-hidden />
              {option.label}
            </span>
          </Radio.Root>
        ))}
      </BaseRadioGroup>
    </div>
  );
}
