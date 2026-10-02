/**
 * CNV-14 — the explicit width × height control of "Image to size".
 *
 * Aspect-locked by default: typing one side makes it the one that is sent
 * (`driver` — the side last typed, locked or not), and the other is shown as it will come out — the image's own
 * proportions, worked out by the same `exactOutputSize` the worker uses — or
 * "Auto" when the image's size is not known yet (a HEIC or TIFF before its
 * first run). Unlocking sends both sides, and the output is exactly that size.
 *
 * The lock is a toggle button (`aria-pressed`) between the two fields, so the
 * tab order is width → lock → height and Space/Enter flips it.
 *
 * Also used by PDF → Images, where `sourceSize` is the first exported page's
 * size (only its proportions matter), `children` says when other pages come
 * out differently, and the enlargement note is off: a page is rendered
 * straight to the size asked for, so a larger size is real detail.
 */
import type { ComponentChildren } from 'preact';
import { Link2, Link2Off } from 'lucide-preact';
import { useId } from 'preact/hooks';
import { useTranslation } from '../../../core/i18n';
import { EXACT_SIDE_BOUNDS, exactOutputSize, type ImageSize } from '../../../core/image-target';
import { Field, NumberInput } from '../../components/Field';
import { IconButton } from '../../components/IconButton';
import { panelStyles } from '../../shell/panelStyles';
import {
  editExactSide,
  exactRequest,
  exactSizeProblem,
  toggleExactLock,
  type ExactSizeSettings
} from './state';
import styles from './ExactSizeInput.module.css';

type Side = 'width' | 'height';

function parseSide(raw: string): number {
  return raw.trim() === '' ? NaN : Number(raw);
}

export function ExactSizeInput({
  value,
  sourceSize,
  onChange,
  warnOnEnlarge = true,
  children
}: {
  value: ExactSizeSettings;
  /** The image's decoded (EXIF-oriented) size, when known. */
  sourceSize: ImageSize | null;
  onChange: (next: ExactSizeSettings) => void;
  /** Say so when the size is larger than `sourceSize` (an upscale of a raster). */
  warnOnEnlarge?: boolean;
  /** Shown under the description, while the setting is usable. */
  children?: ComponentChildren;
}) {
  const t = useTranslation();
  const output = sourceSize ? exactOutputSize(sourceSize, exactRequest(value)) : null;
  const problem = exactSizeProblem(value);

  /** What a side's field shows: as typed, or — locked, the other side — as it will come out. */
  const shown = (side: Side): number | '' => {
    if (!value.lockAspect || value.driver === side) {
      return Number.isNaN(value[side]) ? '' : value[side];
    }
    return output ? output[side] : '';
  };

  // The side last typed in always drives, locked or not (`editExactSide`),
  // so re-locking keeps it exact (`toggleExactLock`).
  const edit = (side: Side, raw: string) => onChange(editExactSide(value, side, parseSide(raw)));
  const toggleLock = () => onChange(toggleExactLock(value, output));

  const errorId = `${useId()}-exact-error`;
  const field = (side: Side, label: string) => (
    <Field label={label}>
      {id => (
        <NumberInput
          id={id}
          className={styles.input}
          min={EXACT_SIDE_BOUNDS.min}
          max={EXACT_SIDE_BOUNDS.max}
          step={1}
          inputMode="numeric"
          value={shown(side)}
          placeholder={t('Auto')}
          aria-invalid={problem === 'invalid' ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          data-image-size-exact={side}
          onInput={event => edit(side, (event.target as HTMLInputElement).value)}
        />
      )}
    </Field>
  );

  return (
    <div className={panelStyles.section}>
      <div className={styles.row}>
        {field('width', t('Width (px)'))}
        <IconButton
          icon={value.lockAspect ? Link2 : Link2Off}
          active={value.lockAspect}
          aria-pressed={value.lockAspect}
          aria-label={t('Keep proportions')}
          title={t('Keep proportions')}
          data-image-size-lock={value.lockAspect ? 'on' : 'off'}
          onClick={toggleLock}
        />
        {field('height', t('Height (px)'))}
      </div>
      <p className={panelStyles.description}>
        {value.lockAspect
          ? t('Proportions are kept: the side you type is exact and the other follows.')
          : t('Proportions are unlocked: the result is exactly this size, stretched if needed.')}
      </p>
      {problem === 'invalid' && (
        <p id={errorId} className={panelStyles.note} role="alert" data-exact-error="">
          {t('Enter a whole number of pixels between {min} and {max}.', {
            min: EXACT_SIDE_BOUNDS.min,
            max: EXACT_SIDE_BOUNDS.max
          })}
        </p>
      )}
      {problem === 'missing' && (
        <p id={errorId} className={panelStyles.description} data-exact-error="">
          {t('Enter a width or a height.')}
        </p>
      )}
      {!problem && children}
      {!problem &&
        warnOnEnlarge &&
        output &&
        sourceSize &&
        (output.width > sourceSize.width || output.height > sourceSize.height) && (
          <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
            {t(
              'That is larger than the image ({width}×{height} px), so it will be enlarged. Enlarging adds no detail.',
              { width: sourceSize.width, height: sourceSize.height }
            )}
          </p>
        )}
    </div>
  );
}
