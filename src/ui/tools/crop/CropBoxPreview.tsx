import type { CropBox } from './state';
import styles from './CropBoxPreview.module.css';

export interface CropBoxPreviewProps {
  box: CropBox;
}

/**
 * A read-only echo of `CropOverlay`'s dimmed-margin look, for a page grid tile
 * rather than the single-page Crop canvas — no drag handles, no pointer
 * handling, just the same box so a crop set earlier stays visible while the
 * user reorders, merges, or watermarks in a different tool.
 */
export function CropBoxPreview({ box }: CropBoxPreviewProps) {
  return (
    <div className={styles.layer} aria-hidden="true">
      <div
        className={styles.dim}
        style={{ left: 0, top: 0, width: '100%', height: `${box.y * 100}%` }}
      />
      <div
        className={styles.dim}
        style={{ left: 0, top: `${(box.y + box.height) * 100}%`, width: '100%', bottom: 0 }}
      />
      <div
        className={styles.dim}
        style={{
          left: 0,
          top: `${box.y * 100}%`,
          width: `${box.x * 100}%`,
          height: `${box.height * 100}%`
        }}
      />
      <div
        className={styles.dim}
        style={{
          left: `${(box.x + box.width) * 100}%`,
          top: `${box.y * 100}%`,
          right: 0,
          height: `${box.height * 100}%`
        }}
      />
      <div
        className={styles.box}
        data-testid="crop-box-preview"
        style={{
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`
        }}
      />
    </div>
  );
}
