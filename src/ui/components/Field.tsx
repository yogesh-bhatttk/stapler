/**
 * Form primitives from DESIGN-ADAPTATION §5.
 *
 * The options panel previously hand-rolled every control with an inline `style`
 * object, repeated eight times, using native inputs with no visible boundary (the
 * `--hairline` token is 1.24:1 on white) and labels wired by proximity rather than
 * by `htmlFor`. These carry the label association, the 3:1 boundary, the focus ring,
 * and the 32px target height once.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import styles from './Field.module.css';

export interface FieldProps {
  label: string;
  hint?: string;
  /** Shown right-aligned on the label row, e.g. a slider's current value. */
  value?: ComponentChildren;
  children: (id: string) => ComponentChildren;
}

/** Label + hint + control, with the `for`/`id` pairing done for you. */
export function Field({ label, hint, value, children }: FieldProps) {
  const id = useId();
  return (
    <div className={styles.field}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {value !== undefined && <span className={styles.value}>{value}</span>}
      </div>
      {children(id)}
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

export function TextInput(props: JSX.IntrinsicElements['input']) {
  const { className = '', ...rest } = props;
  return <input type="text" className={`${styles.control} ${className}`} {...rest} />;
}

export function NumberInput(props: JSX.IntrinsicElements['input']) {
  const { className = '', ...rest } = props;
  return <input type="number" className={`${styles.control} ${className}`} {...rest} />;
}

export function TextArea(props: JSX.IntrinsicElements['textarea']) {
  const { className = '', ...rest } = props;
  return <textarea className={`${styles.control} ${styles.textarea} ${className}`} {...rest} />;
}

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string | number> {
  id?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  disabled
}: SelectProps<T>) {
  return (
    <select
      id={id}
      className={styles.control}
      value={String(value)}
      disabled={disabled}
      onChange={event => {
        const raw = (event.target as HTMLSelectElement).value;
        // Numeric options round-trip through the DOM as strings; restore the type
        // so callers do not have to parse at every use.
        const match = options.find(option => String(option.value) === raw);
        if (match) onChange(match.value);
      }}
    >
      {options.map(option => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface RadioGroupProps<T extends string> {
  legend: string;
  name: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A real `fieldset`/`legend`, so a screen reader announces what the choice is for
 * rather than reading four unrelated radio labels.
 */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange
}: RadioGroupProps<T>) {
  return (
    <fieldset className={styles.radioGroup}>
      <legend>{legend}</legend>
      {options.map(option => (
        <label className={styles.radio} key={option.value}>
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className={styles.radioBody}>
            <span>{option.label}</span>
            {option.hint && <span className={styles.radioHint}>{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export interface SliderProps {
  id?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Endpoint captions, e.g. ['Strict', 'Forgiving']. */
  scale?: [string, string];
  ariaLabel?: string;
}

export function Slider({
  id,
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
  scale,
  ariaLabel
}: SliderProps) {
  return (
    <div>
      <input
        id={id}
        className={styles.slider}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        // `input`, not `change`: a range slider must update while dragging or the
        // live preview only appears once the pointer is released.
        onInput={event => onChange(Number((event.target as HTMLInputElement).value))}
      />
      {scale && (
        <div className={styles.sliderScale}>
          <span>{scale[0]}</span>
          <span>{scale[1]}</span>
        </div>
      )}
    </div>
  );
}

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className={styles.checkbox}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange((event.target as HTMLInputElement).checked)}
      />
      {label}
    </label>
  );
}
