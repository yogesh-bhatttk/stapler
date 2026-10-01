/**
 * IMG-2 / IMG-12 — the amount + unit pair behind every target-size field
 * (Image to size, Compress → "Aim for a size").
 *
 * The rule is that a run never uses a value different from the one on screen.
 * The field used to drop an out-of-range keystroke silently — "4" KB stayed on
 * screen while the run used the previous 50 KB — and switching the unit kept
 * the number, so 0.5 MB became 0.5 KB. Now:
 *
 *  - every keystroke is stored as typed (even an empty or out-of-range one),
 *    so the settings always match the field;
 *  - an unusable value shows an inline error with the allowed range, and the
 *    commit handler refuses to run with it (`validateSizeParam`);
 *  - changing the unit converts the amount, so the size stays the same.
 */
import { useState } from 'preact/hooks';
import {
  convertSizeUnit,
  validateSizeParam,
  type SizeBounds,
  type SizeParam,
  type SizeUnit
} from '../../../core/deep-link';
import { useTranslation } from '../../../core/i18n';
import { formatBytes } from '../../components/Feedback';
import { NumberInput, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';

const UNIT_OPTIONS = [
  { value: 'KB' as SizeUnit, label: 'KB' },
  { value: 'MB' as SizeUnit, label: 'MB' }
] as const;

/** The inline message for an unusable target, or null when it is usable. */
export function targetSizeError(
  size: SizeParam,
  bounds: SizeBounds,
  t: (key: string, values?: Record<string, string | number>) => string
): string | null {
  const check = validateSizeParam(size, bounds);
  if (check.ok) return null;
  return t('Enter a size between {min} and {max}.', {
    min: formatBytes(bounds.minBytes),
    max: formatBytes(bounds.maxBytes)
  });
}

function sameAmount(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

export function TargetSizeInput({
  id,
  value,
  bounds,
  onChange,
  steps,
  dataAttribute
}: {
  id: string;
  value: SizeParam;
  bounds: SizeBounds;
  onChange: (next: SizeParam) => void;
  /** Spinner step per unit. */
  steps: Record<SizeUnit, number>;
  /** A `data-*` attribute carrying the amount, for tests (`data-target-amount`). */
  dataAttribute: string;
}) {
  const t = useTranslation();
  // The text as typed, kept only while it still is the stored amount — so an
  // outside change (a quick-pick button, a deep link) shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const draftAmount = draft === null || draft.trim() === '' ? NaN : Number(draft);
  const shown = draft !== null && sameAmount(draftAmount, value.amount) ? draft : value.amount;
  const error = targetSizeError(value, bounds, t);
  const errorId = `${id}-error`;
  const minAmount = value.unit === 'MB' ? bounds.minBytes / 1_000_000 : bounds.minBytes / 1000;
  const maxAmount = value.unit === 'MB' ? bounds.maxBytes / 1_000_000 : bounds.maxBytes / 1000;

  return (
    <>
      <div className={panelStyles.actions}>
        <NumberInput
          id={id}
          min={minAmount}
          max={maxAmount}
          step={steps[value.unit]}
          value={Number.isNaN(shown as number) ? '' : shown}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          {...{ [dataAttribute]: value.amount }}
          onInput={event => {
            const raw = (event.target as HTMLInputElement).value;
            setDraft(raw);
            const amount = raw.trim() === '' ? NaN : Number(raw);
            onChange({ amount, unit: value.unit });
          }}
        />
        <Select
          value={value.unit}
          options={UNIT_OPTIONS}
          ariaLabel={t('Target size unit')}
          onChange={unit => {
            setDraft(null);
            onChange(convertSizeUnit(value, unit));
          }}
        />
      </div>
      {error && (
        <p id={errorId} className={panelStyles.note} role="alert" data-target-error="">
          {error}
        </p>
      )}
    </>
  );
}
