/**
 * DOC-09 — Contact sheet export panel.
 *
 * Tiles page thumbnails into a grid on A4 and lets the user download
 * the result as a PDF.
 */
import { LayoutGrid } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, exportContactSheet } from '../../../core/operations';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import { CONTACT_SHEET_COL_OPTIONS, contactSheetColumns } from './state';

export function ContactSheetPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run, isRunning } = useJob();
  const cols = contactSheetColumns.value;

  if (!doc) return null;

  const handleExport = () =>
    run({ label: 'Exporting contact sheet', scope: 'contact-sheet' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const outBytes = await exportContactSheet(bytes, cols, job);
      const stem = doc.name.replace(/\.[^.]+$/, '');
      await platform.saveFileAs(outBytes, `${stem}-contact-sheet.pdf`);
    });

  return (
    <>
      <div className={panelStyles.section}>
        <p style={{ margin: '0 0 12px', fontSize: '0.875em', opacity: 0.8 }}>
          {t('Export all pages as a thumbnail grid on A4.')}
        </p>

        <Field label={t('Columns')}>
          {id => (
            <select
              id={id}
              value={cols}
              onChange={e =>
                (contactSheetColumns.value = Number((e.target as HTMLSelectElement).value))
              }
            >
              {CONTACT_SHEET_COL_OPTIONS.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <div className={panelStyles.section}>
        <Button
          id="contact-sheet-export-btn"
          onClick={handleExport}
          disabled={isRunning()}
          icon={LayoutGrid}
        >
          {isRunning() ? t('Exporting…') : t('Export contact sheet')}
        </Button>
      </div>
    </>
  );
}
