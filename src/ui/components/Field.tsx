import { translate } from '../../core/i18n';
/**
 * Form primitives from DESIGN-ADAPTATION §5.
 *
 * The options panel previously hand-rolled every control with an inline `style`
 * object, repeated eight times, using native inputs with no visible boundary (the
 * `--hairline` token is 1.24:1 on white) and labels wired by proximity rather than
 * by `htmlFor`. These carry the label association, the 3:1 boundary, the focus ring,
 * and the 32px target height once.
 */
import type { ComponentChildren, JSX, Ref } from 'preact';
import { forwardRef } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Minus, Plus } from 'lucide-preact';
import { IconButton } from './IconButton';
import { mergeRefs } from './mergeRefs';
import styles from './Field.module.css';

export interface FieldProps {
  label: string;
  hint?: string;
  /** Shown right-aligned on the label row, e.g. a slider's current value. */
  value?: ComponentChildren;
  children: (id: string) => ComponentChildren;
}

/** Label + hint + control, with the `for`/`id` pairing done for you. */
export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  { label, hint, value, children },
  ref
) {
  const id = useId();
  return (
    <div ref={ref} className={styles.field}>
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
});

export const TextInput = forwardRef<HTMLInputElement, JSX.IntrinsicElements['input']>(
  function TextInput(props, ref) {
    const { className = '', ...rest } = props;
    return <input ref={ref} type="text" className={`${styles.control} ${className}`} {...rest} />;
  }
);

export const NumberInput = forwardRef<HTMLInputElement, JSX.IntrinsicElements['input']>(
  function NumberInput(props, ref) {
    const { className = '', ...rest } = props;
    return <input ref={ref} type="number" className={`${styles.control} ${className}`} {...rest} />;
  }
);

export const TextArea = forwardRef<HTMLTextAreaElement, JSX.IntrinsicElements['textarea']>(
  function TextArea(props, ref) {
    const { className = '', ...rest } = props;
    return (
      <textarea
        ref={ref}
        className={`${styles.control} ${styles.textarea} ${className}`}
        {...rest}
      />
    );
  }
);

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

/**
 * `forwardRef` erases a component's own generic type parameter — the inner
 * render function stays generic, but `preact/compat`'s `forwardRef` signature
 * only ever sees the erased, non-generic version of it. This re-asserts the
 * generic signature on the outside, which is safe: the runtime behaviour is
 * unchanged, only the type callers see is restored.
 */
function forwardRefGeneric<T, P>(
  render: (props: P, ref: Ref<T>) => JSX.Element | null
): (props: P & { ref?: Ref<T> }) => JSX.Element | null {
  return forwardRef(render as (props: object, ref: Ref<T>) => JSX.Element | null) as unknown as (
    props: P & { ref?: Ref<T> }
  ) => JSX.Element | null;
}

export const Select = forwardRefGeneric(function Select<T extends string | number>(
  { id, value, options, onChange, disabled, ariaLabel }: SelectProps<T>,
  ref: Ref<HTMLSelectElement>
) {
  return (
    <select
      ref={ref}
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
}) as <T extends string | number>(
  props: SelectProps<T> & { ref?: Ref<HTMLSelectElement> }
) => JSX.Element | null;

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
export const RadioGroup = forwardRefGeneric(function RadioGroup<T extends string>(
  { legend, name, value, options, onChange }: RadioGroupProps<T>,
  ref: Ref<HTMLFieldSetElement>
) {
  return (
    <fieldset ref={ref} className={styles.radioGroup}>
      <legend>{legend}</legend>
      {options.map(option => (
        <RadioOptionRow
          key={option.value}
          name={name}
          option={option}
          checked={value === option.value}
          onChange={onChange}
        />
      ))}
    </fieldset>
  );
}) as <T extends string>(
  props: RadioGroupProps<T> & { ref?: Ref<HTMLFieldSetElement> }
) => JSX.Element | null;

/**
 * `aria-label` keeps the accessible name to just the option label — without it, the
 * native label-wraps-input rule folds the hint text into the name too, so a hint like
 * "...pages per file..." makes the radio's name collide with an unrelated field's
 * `getByLabel('Pages per file')` lookup elsewhere on the same panel. `aria-describedby`
 * still exposes the hint to screen readers, as a description rather than the name.
 */
function RadioOptionRow<T extends string>({
  name,
  option,
  checked,
  onChange
}: {
  name: string;
  option: RadioOption<T>;
  checked: boolean;
  onChange: (value: T) => void;
}) {
  const hintId = useId();
  return (
    <label className={styles.radio}>
      <input
        type="radio"
        name={name}
        aria-label={option.label}
        aria-describedby={option.hint ? hintId : undefined}
        checked={checked}
        onChange={() => onChange(option.value)}
      />
      <span className={styles.radioBody}>
        <span>{option.label}</span>
        {option.hint && (
          <span id={hintId} className={styles.radioHint}>
            {option.hint}
          </span>
        )}
      </span>
    </label>
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

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { id, min, max, step = 1, value, onChange, disabled, scale, ariaLabel },
  ref
) {
  return (
    <div>
      <input
        ref={ref}
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
});

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, checked, onChange, disabled },
  ref
) {
  return (
    <label className={styles.checkbox}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange((event.target as HTMLInputElement).checked)}
      />
      {label}
    </label>
  );
});

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

/** A number input with +/- controls. Arrow keys step; typing edits directly. The
 * forwarded ref lands on the text input at the centre — the part of this
 * composite control a caller would actually want to focus or measure. */
export const NumberStepper = forwardRef<HTMLInputElement, NumberStepperProps>(
  function NumberStepper(
    { id, value, onChange, min = -Infinity, max = Infinity, step = 1, disabled, ariaLabel },
    ref
  ) {
    // Text state is separate from the committed value so an in-progress edit like
    // "1" while typing "12" is not clobbered by a re-clamp on every keystroke. Only
    // resynced from an external value change while the input is not focused, so
    // typing is never overwritten mid-edit.
    const [text, setText] = useState(String(value));
    const focused = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);
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
          aria-label={translate('Decrease')}
          disabled={disabled || value <= min}
          onClick={() => commit(value - step)}
        />
        <input
          ref={mergeRefs(inputRef, ref)}
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
          aria-label={translate('Increase')}
          disabled={disabled || value >= max}
          onClick={() => commit(value + step)}
        />
      </div>
    );
  }
);

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
export const SegmentedControl = forwardRefGeneric(function SegmentedControl<T extends string>(
  { legend, name, value, options, onChange, disabled }: SegmentedControlProps<T>,
  ref: Ref<HTMLFieldSetElement>
) {
  return (
    <fieldset ref={ref} className={styles.segmented} disabled={disabled}>
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
}) as <T extends string>(
  props: SegmentedControlProps<T> & { ref?: Ref<HTMLFieldSetElement> }
) => JSX.Element | null;
