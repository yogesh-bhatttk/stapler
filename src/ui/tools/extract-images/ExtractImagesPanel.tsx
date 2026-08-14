/**
 * CNV-06 — extract embedded images.
 *
 * No settings: the whole point of this tool is that it does not re-encode, so
 * there is no format or quality to choose. The panel's job is to say what will
 * happen, and afterwards to account for every image the document holds —
 * including the ones deliberately left in it.
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { panelStyles } from '../../shell/OptionsPanel';
import { useTranslation } from '../../../core/i18n';
import { extractImagesReport, summarize } from './state';

export function ExtractImagesPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const report = extractImagesReport.value;
  if (!doc) return null;

  const selected = selectedPageKeys.value.size;
  const pageCount = selected > 0 ? selected : doc.pages.length;
  const summary = report && report.docId === doc.id ? summarize(report.entries) : null;

  return (
    <>
      <p className={panelStyles.description}>
        {selected > 0
          ? `${pageCount} ${t('selected page(s).')}`
          : `${t('All')} ${pageCount} ${t('pages.')}`}{' '}
        {t(
          'Each embedded image is written to a ZIP at its original resolution, in the format it is stored in — JPEG stays the same bytes, never re-compressed.'
        )}
      </p>

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t(
          'An image that has no lossless single-file form — CMYK rasters, JBIG2 and CCITT fax data — is listed here and left in the document rather than converted.'
        )}
      </p>

      {summary && (
        <div className={panelStyles.section}>
          <p className={panelStyles.description}>
            {`${summary.fileCount} ${t('file(s) written')}`}
            {summary.maskCount > 0 && `, ${summary.maskCount} ${t('transparency mask(s)')}`}
            {summary.duplicateCount > 0 &&
              `, ${summary.duplicateCount} ${t('reuse(s) of an image already extracted')}`}
            {summary.skippedCount > 0 && `, ${summary.skippedCount} ${t('left untouched')}`}.
          </p>
          {summary.reasons.length > 0 && (
            <ul className={panelStyles.description}>
              {summary.reasons.map(reason => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
