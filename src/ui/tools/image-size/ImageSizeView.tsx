/**
 * GAP-5 — the canvas for "Image to size": the last result as it will be
 * saved, with its measured size, or a live preview of the source while it's
 * still waiting on a first "Resize & save".
 *
 * The source preview only works for formats the browser decodes on its own
 * (PNG/JPEG/WebP/GIF) — HEIC and TIFF need this app's own decoder, so those
 * fall back to the filename-only placeholder. A before/after pair of numbers
 * is what the person actually needs to check against a form's limit, and the
 * panel shows that too. A file the browser still cannot draw (damaged, or not
 * what its name says) falls back to the same placeholder via `onError` rather
 * than showing a broken image (IMG-10).
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { isBrowserRenderableImage } from '../../../core/image';
import { EmptyState, formatBytes, formatBytesUp } from '../../components/Feedback';
import { useTranslation } from '../../../core/i18n';
import { imageSizeResult, imageSizeSettings } from './state';
import styles from './ImageSizeView.module.css';

export function ImageSizeView() {
  const t = useTranslation();
  const settings = imageSizeSettings.value;
  const result = imageSizeResult.value;
  const shown = result && result.source === settings.file ? result : null;

  // A kept original is saved as it is (PNG, WebP, …); anything else is a JPEG.
  const resultType = shown?.keptOriginal ? shown.source.type || 'image/jpeg' : 'image/jpeg';
  const resultUrl = useMemo(
    () =>
      shown ? URL.createObjectURL(new Blob([shown.bytes as BlobPart], { type: resultType })) : null,
    [shown?.bytes, resultType]
  );
  // The object URL whose `<img>` failed to draw, so it is not retried.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    },
    [resultUrl]
  );

  const previewSource = !shown && settings.file && isBrowserRenderableImage(settings.file);
  const sourceUrl = useMemo(
    () => (previewSource ? URL.createObjectURL(settings.file as File) : null),
    [settings.file, previewSource]
  );
  useEffect(
    () => () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    },
    [sourceUrl]
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

  if (!shown || !resultUrl) {
    const caption = t('{size} now. Press Resize & save to make the smaller version.', {
      size: formatBytes(settings.file.size)
    });

    if (!sourceUrl || sourceUrl === brokenUrl) {
      return <EmptyState title={settings.file.name} body={caption} />;
    }

    return (
      <div className={styles.view}>
        <figure className={styles.figure}>
          <img
            className={styles.image}
            src={sourceUrl}
            alt={t('{name}, before resizing', { name: settings.file.name })}
            onError={() => setBrokenUrl(sourceUrl)}
          />
          <figcaption className={styles.caption}>{caption}</figcaption>
        </figure>
      </div>
    );
  }

  const sizes = t('{before} → {after} · {width}×{height} px', {
    before: formatBytes(shown.source.size),
    // An overshoot is rounded up, so it never reads as the limit itself (IMG-3).
    after: shown.reached
      ? formatBytes(shown.bytes.byteLength)
      : formatBytesUp(shown.bytes.byteLength),
    width: shown.width,
    height: shown.height
  });
  const status = (
    <span
      className={`${styles.status} ${shown.reached ? styles.reached : styles.missed}`}
      role="status"
    >
      {shown.reached ? t('Fits the limit') : t('Over the limit')}
    </span>
  );

  if (resultUrl === brokenUrl) {
    return <EmptyState title={shown.source.name} body={sizes} action={status} />;
  }

  return (
    <div className={styles.view}>
      <figure className={styles.figure}>
        <img
          className={styles.image}
          onError={() => setBrokenUrl(resultUrl)}
          src={resultUrl}
          width={shown.width}
          height={shown.height}
          alt={t('Resized version of {name}', { name: shown.source.name })}
        />
        <figcaption className={styles.caption}>
          {status} {sizes}
        </figcaption>
      </figure>
    </div>
  );
}
