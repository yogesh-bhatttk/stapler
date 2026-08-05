import { watermarkSettings } from './state';
import { activeDoc, sources } from '../../../core/store';
import styles from './WatermarkOverlay.module.css';

export interface WatermarkOverlayProps {
  pageIndex: number;
  width: number;
  height: number;
}

export function WatermarkOverlay({ pageIndex, width }: WatermarkOverlayProps) {
  const doc = activeDoc.value;
  const settings = watermarkSettings.value;
  if (!doc || !settings.text) return null;

  const page = doc.pages[pageIndex];
  const pageWidth = page
    ? sources.value[page.sourceDocId]?.pageSizes[page.sourceIndex]?.width
    : undefined;
  const scale = pageWidth ? width / pageWidth : 1;

  const totalPages = doc.pages.length;
  const displayText = settings.text
    .replace(/{n}/g, String(settings.startAt + pageIndex))
    .replace(/{total}/g, String(totalPages));

  const [vertical, horizontal] = settings.position.split('-');
  const vAlign = vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center';
  const hAlign =
    horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center';

  const inRange = (() => {
    const value = settings.pageRange.trim().toLowerCase();
    if (!value || value === 'all') return true;
    return value.split(',').some(part => {
      const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) return false;
      const from = Number(match[1]);
      const to = Number(match[2] ?? match[1]);
      const current = pageIndex + 1;
      return current >= Math.min(from, to) && current <= Math.max(from, to);
    });
  })();
  if (!inRange) return null;

  return (
    <div
      className={styles.overlay}
      style={{
        alignItems: hAlign,
        justifyContent: vAlign,
        padding: `${Math.max(12, Math.round(36 * scale))}px`
      }}
    >
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
        {displayText}
      </div>
    </div>
  );
}
