/**
 * GAP-5 — the canvas for "Image to size": the last result as it will be
 * saved, with its measured size, or a prompt to choose an image.
 *
 * Only the result is previewed. The source may be HEIC or TIFF, which the
 * browser cannot show, and a before/after pair of numbers is what the person
 * actually needs to check against a form's limit (the panel shows it too).
 */
import { useEffect, useMemo } from 'preact/hooks';
import { EmptyState, formatBytes } from '../../components/Feedback';
import { useTranslation } from '../../../core/i18n';
import { imageSizeResult, imageSizeSettings } from './state';
import styles from './ImageSizeView.module.css';

export function ImageSizeView() {
  const t = useTranslation();
  const settings = imageSizeSettings.value;
  const result = imageSizeResult.value;
  const shown = result && result.source === settings.file ? result : null;

  const url = useMemo(
    () =>
      shown
        ? URL.createObjectURL(new Blob([shown.bytes as BlobPart], { type: 'image/jpeg' }))
        : null,
    [shown?.bytes]
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url]
  );

  if (!settings.file) {
    return (
      <EmptyState
        title={t('Choose an image to shrink')}
        body={t(
          'Pick a photo in the options panel, set the size your form allows, then press Resize & save. Nothing is uploaded.'
        )}
      />
    );
  }

  if (!shown || !url) {
    return (
      <EmptyState
        title={settings.file.name}
        body={t('{size} now. Press Resize & save to make the smaller version.', {
          size: formatBytes(settings.file.size)
        })}
      />
    );
  }

  return (
    <div className={styles.view}>
      <figure className={styles.figure}>
        <img
          className={styles.image}
          src={url}
          width={shown.width}
          height={shown.height}
          alt={t('Resized version of {name}', { name: shown.source.name })}
        />
        <figcaption className={styles.caption}>
          <span
            className={`${styles.status} ${shown.reached ? styles.reached : styles.missed}`}
            role="status"
          >
            {shown.reached ? t('Fits the limit') : t('Over the limit')}
          </span>{' '}
          {t('{before} → {after} · {width}×{height} px', {
            before: formatBytes(shown.source.size),
            after: formatBytes(shown.bytes.byteLength),
            width: shown.width,
            height: shown.height
          })}
        </figcaption>
      </figure>
    </div>
  );
}
