/**
 * GAP-5 — "Image to size" options: pick one image, set a file-size target
 * and/or a longest-side limit, commit from the action bar. The last result's
 * before/after sizes are shown here and its preview on the canvas.
 */
import { ImagePlus } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { IMAGES_ONLY } from '../../../platform/index';
import { isSupportedImage } from '../../../core/image';
import { notify } from '../../../core/notify';
import { activeDoc, activeSources, getSourceOriginalFiles } from '../../../core/store';
import { IMAGE_TARGET_BOUNDS, sizeParamBytes, type SizeUnit } from '../../../core/deep-link';
import { tPlural, useTranslation } from '../../../core/i18n';
import { Button } from '../../components/Button';
import { Checkbox, Field, NumberInput, Select } from '../../components/Field';
import { SizeDelta, formatBytes } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import { maxDimensionOptions } from '../convert/pdf-to-img-state';
import { imageSizeResult, imageSizeSettings, type ImageSizeSettings } from './state';

const UNIT_OPTIONS = [
  { value: 'KB' as SizeUnit, label: 'KB' },
  { value: 'MB' as SizeUnit, label: 'MB' }
] as const;

/** The limits upload forms most often quote. */
const QUICK_TARGETS_KB = [20, 50, 100, 200, 500] as const;

function update(patch: Partial<ImageSizeSettings>) {
  imageSizeSettings.value = { ...imageSizeSettings.value, ...patch };
}

function chooseFile(file: File) {
  update({ file });
  // A result describes the file it was made from; a new pick hides it.
  if (imageSizeResult.value && imageSizeResult.value.source !== file) {
    imageSizeResult.value = null;
  }
}

export function ImageSizePanel() {
  const t = useTranslation();
  const settings = imageSizeSettings.value;
  const result = imageSizeResult.value;
  const shown = result && result.source === settings.file ? result : null;
  const doc = activeDoc.value;
  const openImage = doc
    ? activeSources.value
        .flatMap(source => getSourceOriginalFiles(source.id) ?? [])
        .find(isSupportedImage)
    : undefined;

  const pick = async () => {
    const opened = await platform.openFiles({ multiple: false, accept: IMAGES_ONLY });
    if (opened.length === 0) return;
    const file = await opened[0].getFile();
    if (!isSupportedImage(file)) {
      notify(
        'warning',
        t('{name} is not an image Stapler can read (JPEG, PNG, WebP, GIF, HEIC or TIFF).', {
          name: file.name
        })
      );
      return;
    }
    chooseFile(file);
  };

  const targetBytes = sizeParamBytes(settings.target);
  const minAmount = settings.target.unit === 'MB' ? 0.01 : IMAGE_TARGET_BOUNDS.minBytes / 1000;
  const maxAmount =
    settings.target.unit === 'MB'
      ? IMAGE_TARGET_BOUNDS.maxBytes / 1_000_000
      : IMAGE_TARGET_BOUNDS.maxBytes / 1000;

  return (
    <>
      <div className={panelStyles.section}>
        <Button variant="secondary" icon={ImagePlus} onClick={pick}>
          {settings.file ? t('Choose a different image') : t('Choose an image')}
        </Button>
        {openImage && openImage !== settings.file && (
          <Button variant="secondary" size="compact" onClick={() => chooseFile(openImage)}>
            {t('Use “{name}”, the open image', { name: openImage.name })}
          </Button>
        )}
        {settings.file ? (
          <p className={panelStyles.description} data-image-size-file={settings.file.name}>
            {t('{name} — {size}', {
              name: settings.file.name,
              size: formatBytes(settings.file.size)
            })}
          </p>
        ) : (
          <p className={panelStyles.description}>
            {t('JPEG, PNG, WebP, GIF, HEIC or TIFF. The result is always a JPEG.')}
          </p>
        )}
      </div>

      <Checkbox
        label={t('Aim for a file size')}
        checked={settings.useTarget}
        onChange={useTarget => update({ useTarget })}
      />

      {settings.useTarget && (
        <>
          <Field
            label={t('Target size')}
            hint={t(
              'Stapler lowers quality first, then pixel size, measuring every attempt. If even a tiny version misses, it says so before saving.'
            )}
          >
            {id => (
              <div className={panelStyles.actions}>
                <NumberInput
                  id={id}
                  min={minAmount}
                  max={maxAmount}
                  step={settings.target.unit === 'MB' ? 0.1 : 5}
                  value={settings.target.amount}
                  data-image-target-amount={settings.target.amount}
                  onInput={event => {
                    const amount = Number((event.target as HTMLInputElement).value);
                    const bytes = sizeParamBytes({ amount, unit: settings.target.unit });
                    if (
                      Number.isFinite(amount) &&
                      bytes >= IMAGE_TARGET_BOUNDS.minBytes &&
                      bytes <= IMAGE_TARGET_BOUNDS.maxBytes
                    ) {
                      update({ target: { ...settings.target, amount } });
                    }
                  }}
                />
                <Select
                  value={settings.target.unit}
                  options={UNIT_OPTIONS}
                  ariaLabel={t('Target size unit')}
                  onChange={unit => update({ target: { ...settings.target, unit } })}
                />
              </div>
            )}
          </Field>
          <div className={panelStyles.actions} role="group" aria-label={t('Common limits')}>
            {QUICK_TARGETS_KB.map(kb => (
              <Button
                key={kb}
                variant="secondary"
                size="compact"
                aria-pressed={settings.target.unit === 'KB' && settings.target.amount === kb}
                onClick={() => update({ target: { amount: kb, unit: 'KB' } })}
              >
                {t('{size} KB', { size: kb })}
              </Button>
            ))}
          </div>
        </>
      )}

      <Field
        label={t('Longest side at most')}
        hint={t('Larger images are scaled down. Smaller ones are never enlarged.')}
      >
        {id => (
          <Select
            id={id}
            value={settings.maxDimension ?? 0}
            options={maxDimensionOptions(settings.maxDimension, t)}
            onChange={value => update({ maxDimension: value > 0 ? value : null })}
          />
        )}
      </Field>

      {!settings.useTarget && settings.maxDimension === null && (
        <p className={panelStyles.note}>
          {t('No limit is set, so the image is only re-saved as an 85% JPEG.')}
        </p>
      )}

      {shown && (
        <div
          className={panelStyles.section}
          data-image-size-outcome={shown.reached ? 'reached' : 'missed'}
          data-image-size-bytes={shown.bytes.byteLength}
        >
          <h2 className={panelStyles.title}>{t('Result')}</h2>
          <SizeDelta before={shown.source.size} after={shown.bytes.byteLength} />
          <p className={panelStyles.description}>
            {shown.keptOriginal
              ? t('The original already fits every limit, so it is kept unchanged.')
              : shown.targetBytes === null
                ? t('{width}×{height} px at {quality}% quality.', {
                    width: shown.width,
                    height: shown.height,
                    quality: Math.round((shown.quality ?? 0) * 100)
                  })
                : shown.reached
                  ? t(
                      'Reached {achieved} — at or under your target of {target}. {width}×{height} px at {quality}% quality.',
                      {
                        achieved: formatBytes(shown.bytes.byteLength),
                        target: formatBytes(shown.targetBytes),
                        width: shown.width,
                        height: shown.height,
                        quality: Math.round((shown.quality ?? 0) * 100)
                      }
                    )
                  : t(
                      'Could not reach {target}. The smallest Stapler could make is {achieved}, at {width}×{height} px.',
                      {
                        target: formatBytes(shown.targetBytes),
                        achieved: formatBytes(shown.bytes.byteLength),
                        width: shown.width,
                        height: shown.height
                      }
                    )}{' '}
            {t('Exactly {bytes} bytes.', { bytes: shown.bytes.byteLength })}
          </p>
          {shown.sourcePages > 1 && (
            <p className={panelStyles.note}>
              {tPlural('This TIFF has {count} pages; only the first was used.', shown.sourcePages)}
            </p>
          )}
        </div>
      )}

      {settings.useTarget && !shown && (
        <p className={panelStyles.description}>
          {t('Target: at most {bytes} bytes.', { bytes: targetBytes })}
        </p>
      )}
    </>
  );
}
