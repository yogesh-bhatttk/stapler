import { watermarkSettings } from './state';
import { activeDoc } from '../../../core/store';
import styles from './WatermarkOverlay.module.css';

export interface WatermarkOverlayProps {
  pageIndex: number;
  width: number;
  height: number;
}

export function WatermarkOverlay({ pageIndex }: WatermarkOverlayProps) {
  const doc = activeDoc.value;
  const settings = watermarkSettings.value;
  if (!doc || !settings.text) return null;

  const totalPages = doc.pages.length;
  const displayText = settings.text
    .replace(/{n}/g, String(pageIndex + 1))
    .replace(/{total}/g, String(totalPages));

  const [vertical, horizontal] = settings.position.split('-');
  const vAlign = vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center';
  const hAlign =
    horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center';

  // Calculate CSS scale based on a reference width of 8.5 * 72 = 612 units
  // so that the preview matches the physical pdf roughly.
  // Actually, we can just use the provided width. The page in SinglePageView is scaled.
  // But wait, the font size is in physical points.
  // We can't perfectly match PDF units if the canvas is zoomed, but let's assume
  // the overlay container is exactly the physical width, or scaled?
  // Usually, the overlay container scales with the page.

  return (
    <div
      className={styles.overlay}
      style={{
        alignItems: hAlign,
        justifyContent: vAlign,
        padding: '36px' // 0.5 inch padding
      }}
    >
      <div
        className={styles.textContainer}
        style={{
          opacity: settings.opacity,
          color: settings.color,
          transform: `rotate(${settings.rotation}deg)`,
          fontSize: `${settings.fontSize}px`,
          whiteSpace: 'pre-wrap',
          textAlign: hAlign === 'flex-start' ? 'left' : hAlign === 'flex-end' ? 'right' : 'center'
        }}
      >
        {displayText}
      </div>
    </div>
  );
}
