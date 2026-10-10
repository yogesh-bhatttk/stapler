import { useEffect, useState } from 'preact/hooks';
import { watermarkSettings, pageInRange } from './state';
import { activeDoc, sources } from '../../../core/store';
import styles from './WatermarkOverlay.module.css';

export interface WatermarkOverlayProps {
  pageIndex: number;
  width: number;
  height: number;
}

/**
 * One object URL per watermark image, shared by every tile that shows it
 * (AUDIT-2026-10-10 UI15). Each overlay used to copy the bytes into its own Blob
 * and URL, so a grid of 40 thumbnails held 40 copies of the image. Entries are
 * ref-counted and the URL is revoked when the last overlay using it lets go —
 * which is when the image is changed or cleared.
 */
const sharedUrls = new Map<Uint8Array, Map<string, { url: string; users: number }>>();

function mimeFor(format: string | undefined): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

export function acquireWatermarkUrl(bytes: Uint8Array, format: string | undefined): string {
  const mime = mimeFor(format);
  let byMime = sharedUrls.get(bytes);
  if (!byMime) {
    byMime = new Map();
    sharedUrls.set(bytes, byMime);
  }
  let entry = byMime.get(mime);
  if (!entry) {
    entry = { url: URL.createObjectURL(new Blob([bytes.slice()], { type: mime })), users: 0 };
    byMime.set(mime, entry);
  }
  entry.users += 1;
  return entry.url;
}

export function releaseWatermarkUrl(bytes: Uint8Array, format: string | undefined): void {
  const mime = mimeFor(format);
  const byMime = sharedUrls.get(bytes);
  const entry = byMime?.get(mime);
  if (!byMime || !entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  URL.revokeObjectURL(entry.url);
  byMime.delete(mime);
  if (byMime.size === 0) sharedUrls.delete(bytes);
}

/** The shared object URL for the current watermark image. */
function useWatermarkImageUrl(bytes: Uint8Array | undefined, format: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    setUrl(acquireWatermarkUrl(bytes, format));
    return () => releaseWatermarkUrl(bytes, format);
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
      // Purely visual — the watermark text/image is baked into the exported
      // PDF's content, not the editor's accessible page name. Matches
      // `CropBoxPreview`'s own overlay, which this component was rendered
      // alongside from the start; the gap only became reachable once
      // `PageGrid` began composing this same component into every visible
      // thumbnail's `role="option"` cell (rather than the single active page
      // in the Watermark tool alone), where it would otherwise be announced
      // once per thumbnail as a screen reader user reviews the grid.
      aria-hidden="true"
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
