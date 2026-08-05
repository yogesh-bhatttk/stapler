import { headerFooterSettings, pageInRange } from './state';
import { activeDoc } from '../../../core/store';
import styles from './HeaderFooterOverlay.module.css';

export interface HeaderFooterOverlayProps {
  pageIndex: number;
}

/**
 * Live preview of the fixed header/footer band — unrotated running text in the
 * page margin, distinct from the (possibly rotated, freely positioned)
 * watermark stamp rendered by `WatermarkOverlay`.
 */
export function HeaderFooterOverlay({ pageIndex }: HeaderFooterOverlayProps) {
  const doc = activeDoc.value;
  const settings = headerFooterSettings.value;
  if (!doc) return null;
  if (!settings.headerText && !settings.footerText) return null;
  if (!pageInRange(settings.pageRange, pageIndex)) return null;

  const totalPages = doc.pages.length;
  const substitute = (text: string) =>
    text.replace(/{n}/g, String(pageIndex + 1)).replace(/{total}/g, String(totalPages));

  return (
    <div className={styles.overlay}>
      {settings.headerText && (
        <div className={styles.line} style={{ textAlign: settings.headerAlign, top: 0 }}>
          {substitute(settings.headerText)}
        </div>
      )}
      {settings.footerText && (
        <div className={styles.line} style={{ textAlign: settings.footerAlign, bottom: 0 }}>
          {substitute(settings.footerText)}
        </div>
      )}
    </div>
  );
}
