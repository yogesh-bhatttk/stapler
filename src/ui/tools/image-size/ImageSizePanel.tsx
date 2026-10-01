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
import { IMAGE_TARGET_BOUNDS, validateSizeParam } from '../../../core/deep-link';
import { tPlural, useTranslation } from '../../../core/i18n';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Field';
import { SizeDelta, formatBytes, formatTargetMiss } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import { maxDimensionOptions } from '../convert/pdf-to-img-state';
import { imageSizeResult, imageSizeSettings, type ImageSizeSettings } from './state';
import { TargetSizeInput } from './TargetSizeInput';

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

  const targetCheck = validateSizeParam(settings.target, IMAGE_TARGET_BOUNDS);

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
            {t(
              'JPEG, PNG, WebP, GIF, HEIC or TIFF. The result is a JPEG — or the original, unchanged, when it already meets every limit and a JPEG would be no smaller.'
            )}
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
              <TargetSizeInput
                id={id}
                value={settings.target}
                bounds={IMAGE_TARGET_BOUNDS}
                steps={{ KB: 5, MB: 0.1 }}
                dataAttribute="data-image-target-amount"
                onChange={target => update({ target })}
              />
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
                        ...formatTargetMiss(shown.targetBytes, shown.bytes.byteLength),
                        width: shown.width,
                        height: shown.height
                      }
                    )}{' '}
            {t('Exactly {bytes} bytes.', { bytes: shown.bytes.byteLength })}
          </p>
          {shown.sourceFrames > 1 && (
            <p className={panelStyles.note}>
              {/* Only shown for two or more frames, so no singular form is needed. */}
              {t('This GIF is animated ({count} frames); only the first frame was used.', {
                count: shown.sourceFrames
              })}
            </p>
          )}
          {shown.sourcePages > 1 && (
            <p className={panelStyles.note}>
              {tPlural('This TIFF has {count} pages; only the first was used.', shown.sourcePages)}
            </p>
          )}
        </div>
      )}

      {settings.useTarget && !shown && targetCheck.ok && (
        <p className={panelStyles.description}>
          {t('Target: at most {bytes} bytes.', { bytes: targetCheck.bytes })}
        </p>
      )}
    </>
  );
}
