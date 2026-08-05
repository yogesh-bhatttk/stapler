import { useEffect, useState } from 'preact/hooks';
import { watermarkSettings, pageInRange } from './state';
import { activeDoc, sources } from '../../../core/store';
import styles from './WatermarkOverlay.module.css';

export interface WatermarkOverlayProps {
  pageIndex: number;
  width: number;
  height: number;
}

/** Object URL for the current watermark image, revoked whenever it changes. */
function useWatermarkImageUrl(bytes: Uint8Array | undefined, format: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([bytes.slice()], { type: format === 'jpeg' ? 'image/jpeg' : 'image/png' })
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, format]);
  return url;
}

export function WatermarkOverlay({ pageIndex, width }: WatermarkOverlayProps) {
  const doc = activeDoc.value;
  const settings = watermarkSettings.value;
  const imageUrl = useWatermarkImageUrl(settings.image?.bytes, settings.image?.format);

  if (!doc) return null;
  if (settings.kind === 'text' && !settings.text) return null;
  if (settings.kind === 'image' && !settings.image) return null;
  if (!pageInRange(settings.pageRange, pageIndex)) return null;

  const page = doc.pages[pageIndex];
  const pageWidth = page
    ? sources.value[page.sourceDocId]?.pageSizes[page.sourceIndex]?.width
    : undefined;
  const scale = pageWidth ? width / pageWidth : 1;

  const totalPages = doc.pages.length;

  const [vertical, horizontal] = settings.position.split('-');
  const vAlign = vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center';
  const hAlign =
    horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center';

  return (
    <div
      className={styles.overlay}
      style={{
        alignItems: hAlign,
        justifyContent: vAlign,
        padding: `${Math.max(12, Math.round(36 * scale))}px`
      }}
    >
      {settings.kind === 'image' && settings.image && imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className={styles.imageWatermark}
          style={{
            opacity: settings.opacity,
            transform: `rotate(${settings.rotation}deg)`,
            width: `${Math.round(width * settings.imageScale)}px`
          }}
        />
      ) : (
        <div
          className={styles.textContainer}
          style={{
            opacity: settings.opacity,
            color: settings.color,
            transform: `rotate(${settings.rotation}deg)`,
            fontSize: `${Math.max(8, settings.fontSize * scale)}px`,
            whiteSpace: 'pre-wrap',
            textAlign: hAlign === 'flex-start' ? 'left' : hAlign === 'flex-end' ? 'right' : 'center'
          }}
        >
          {settings.text
            .replace(/{n}/g, String(settings.startAt + pageIndex))
            .replace(/{total}/g, String(totalPages))}
        </div>
      )}
    </div>
  );
}
