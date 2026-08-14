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
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Minus, Plus } from 'lucide-preact';
import { IconButton } from './IconButton';
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
  /** For a select that has no visible `<label>` of its own (e.g. a unit picker). */
  ariaLabel?: string;
}

export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel
}: SelectProps<T>) {
  return (
    <select
      id={id}
      className={styles.control}
      value={String(value)}
      disabled={disabled}
      aria-label={ariaLabel}
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

export interface NumberStepperProps {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

function clampStep(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A number input with +/- controls. Arrow keys step; typing edits directly. */
export function NumberStepper({
  id,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled,
  ariaLabel
}: NumberStepperProps) {
  // Text state is separate from the committed value so an in-progress edit like
  // "1" while typing "12" is not clobbered by a re-clamp on every keystroke. Only
  // resynced from an external value change while the input is not focused, so
  // typing is never overwritten mid-edit.
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const commit = (next: number) => {
    const clamped = clampStep(next, min, max);
    onChange(clamped);
    setText(String(clamped));
  };

  return (
    <div className={styles.stepper}>
      <IconButton
        icon={Minus}
        size="compact"
        aria-label="Decrease"
        disabled={disabled || value <= min}
        onClick={() => commit(value - step)}
      />
      <input
        id={id}
        className={styles.stepperInput}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={min === -Infinity ? undefined : min}
        aria-valuemax={max === -Infinity ? undefined : max}
        aria-valuenow={value}
        disabled={disabled}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onInput={event => setText((event.target as HTMLInputElement).value)}
        onBlur={() => {
          focused.current = false;
          commit(Number(text) || 0);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') commit(Number(text) || 0);
          else if (event.key === 'ArrowUp') {
            event.preventDefault();
            commit(value + step);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            commit(value - step);
          }
        }}
      />
      <IconButton
        icon={Plus}
        size="compact"
        aria-label="Increase"
        disabled={disabled || value >= max}
        onClick={() => commit(value + step)}
      />
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  legend: string;
  name: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * Built on native radio inputs so arrow-key navigation between segments comes
 * from the browser rather than a hand-rolled roving-tabindex implementation —
 * the same reasoning as `RadioGroup`, laid out as connected pill segments instead.
 */
export function SegmentedControl<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled
}: SegmentedControlProps<T>) {
  return (
    <fieldset className={styles.segmented} disabled={disabled}>
      <legend className={styles.srOnlyLegend}>{legend}</legend>
      {options.map(option => (
        <label
          key={option.value}
          className={`${styles.segment} ${value === option.value ? styles.segmentActive : ''}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
