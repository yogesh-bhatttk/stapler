/**
 * CNV-10 — PDF → Excel (XLSX) options, and the mandatory preview.
 *
 * The preview is not a nicety here, it is the gate: the panel runs the whole
 * conversion, holds the finished bytes, and only then clears `commit-gate`'s block
 * on the action bar's primary CTA. Changing an option or switching document throws
 * the preview away and the gate closes again, because a preview of a different
 * file is worse than no preview at all (PLAN §5.5).
 *
 * The preview matters more for this tool than for either of its siblings. A PDF
 * has no tables — only text that happens to line up — so every sheet here is the
 * output of a guess, and the sheet list plus each table's header row is the one
 * place a wrong guess is visible before the file is written.
 */
import { RefreshCw, Table } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { activeDoc } from '../../../core/store';
import { historyVersion } from '../../../core/history';
import { convertPdfToXlsx, currentDocumentBytes } from '../../../core/operations';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  pdfToExcelOptions,
  pdfToExcelPreview,
  pdfToExcelPreviewIsStale,
  resetPdfToExcelPreview,
  setPdfToExcelPreview
} from './pdf-to-excel-state';

export function PdfToExcelPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const options = pdfToExcelOptions.value;
  const preview = pdfToExcelPreview.value;

  // A preview belongs to one document *at one revision*. Opening another document
  // must not leave the save button unlocked over the previous document's bytes —
  // and neither must editing this one somewhere else (delete a page in Organize,
  // rotate one, crop, annotate) and coming back. Reading `historyVersion.value`
  // here is also what subscribes this component, so the gate closes on the edit
  // rather than on the next unrelated re-render.
  void historyVersion.value;
  const stale = preview !== null && pdfToExcelPreviewIsStale(doc?.id ?? null);
  useEffect(() => {
    if (stale) resetPdfToExcelPreview();
  }, [stale]);

  if (!doc) return null;

  const handlePreview = () => {
    run({ label: 'Converting to Excel', scope: 'convert.pdf-to-excel' }, async job => {
      // Captured before the bytes are read, so an edit made *during* the
      // conversion still invalidates its result.
      const revision = historyVersion.value;
      const bytes = await currentDocumentBytes(job);
      const result = await convertPdfToXlsx(
        bytes,
        { ...pdfToExcelOptions.value, documentName: doc.name },
        job
      );
      setPdfToExcelPreview(result, doc.id, revision);
      notify(
        'success',
        translate('Built {sheets} sheet(s) from {pages} page(s). Review the preview, then save.', {
          sheets: result.sheetCount,
          pages: result.pageCount
        }),
        {
          detail:
            `${formatBytes(result.bytes.byteLength)} · ` + `${result.tableCount} detected table(s)`
        }
      );
    });
  };

  return (
    <>
      {/*
        No heading of its own: `OptionsPanel` already renders the tool's title as
        the panel's `<h1>`, and a second heading with the same words is a
        duplicate landmark for a screen reader rather than extra information.
      */}
      <div className={panelStyles.section}>
        <Badge variant="neutral" aria-label={t('This tool is in beta')}>
          {t('Beta')}
        </Badge>
      </div>

      <p className={panelStyles.description}>
        {t(
          'Finds table-like blocks of text across the whole document and writes each one to its ' +
            'own sheet. A PDF does not record where its tables are — this is inferred from where ' +
            'the text sits on the page, so check every sheet in the preview before you save.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'Every cell is written as text, never as a number, date or formula: a PDF carries the ' +
            'characters that were drawn, not what they meant. Merged cells, borders, colours and ' +
            'column widths are not reconstructed, and a table continued onto the next page ' +
            'becomes a second sheet.'
        )}
      </p>

      {/*
        The measured false positive, named rather than left to the general
        "this is a guess" warning above: a two-column page layout really does
        cluster into a 2-column grid, and a merged banner heading really does end
        up on the text sheet instead of on its table. Both are in the ticket's
        limitation list; a user who is not told about them has no reason to look
        for them in the preview.
      */}
      <p className={panelStyles.description}>
        {t(
          'Two known misreads to look for in the preview: a page laid out in two columns of ' +
            'prose can be picked up as a two-column table, and a heading that spans a table’s ' +
            'width is written to the page’s text sheet rather than above its table.'
        )}
      </p>

      <div className={panelStyles.section}>
        <Checkbox
          label={t('Include page text')}
          checked={options.includePageText}
          onChange={includePageText => {
            pdfToExcelOptions.value = { ...options, includePageText };
            // The previewed file was built the other way round; it is no longer
            // what this panel is describing.
            resetPdfToExcelPreview();
          }}
        />
        <p className={panelStyles.note} style={{ marginTop: 'var(--space-xs)' }}>
          {t(
            'One extra sheet per page, holding the lines that are not inside a detected table — ' +
              'one row per line. Switch it off and those lines are counted and listed rather ' +
              'than written.'
          )}
        </p>
      </div>

      <div className={panelStyles.section}>
        <Button variant="secondary" icon={preview ? RefreshCw : Table} onClick={handlePreview}>
          {preview ? t('Convert again') : t('Preview conversion')}
        </Button>
      </div>

      {preview ? (
        <div className={panelStyles.section}>
          <p className="text-small" style={{ margin: '0 0 var(--space-xs)', fontWeight: 600 }}>
            {t('Preview')} · {preview.sheetCount}{' '}
            {preview.sheetCount === 1 ? t('sheet') : t('sheets')} · {preview.tableCount}{' '}
            {preview.tableCount === 1 ? t('detected table') : t('detected tables')}
          </p>

          <ol
            className={panelStyles.list}
            aria-label={t('Sheets that will be written to the spreadsheet')}
          >
            {preview.outline.map((item, index) => (
              <li key={index} className={panelStyles.listRow}>
                <span
                  className="text-micro"
                  style={{
                    flex: '0 0 auto',
                    minWidth: '108px',
                    color: 'var(--ink-subtle)',
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {item.sheetName}
                </span>
                <span
                  className={panelStyles.listRowText}
                  style={{
                    color: item.kind === 'table' ? 'var(--ink)' : 'var(--ink-muted)',
                    fontWeight: item.kind === 'table' ? 600 : 400
                  }}
                  title={item.text}
                >
                  {item.rowCount} {item.rowCount === 1 ? t('row') : t('rows')} × {item.columnCount}{' '}
                  {item.columnCount === 1 ? t('column') : t('columns')}
                  {item.text ? ` · ${item.text}` : ''}
                </span>
              </li>
            ))}
          </ol>

          {preview.tableCount === 0 && (
            <p className={panelStyles.note} style={{ marginTop: 'var(--space-sm)' }}>
              {t(
                'No table was detected in this document, so each page was written as one row per ' +
                  'line of text instead. Nothing was left out.'
              )}
            </p>
          )}

          {preview.skipped.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <p className={panelStyles.note}>{t('Some content was left out of the workbook:')}</p>
              <ul className={panelStyles.list} style={{ marginTop: 'var(--space-xs)' }}>
                {preview.skipped.map((reason, index) => (
                  <li key={index} className={panelStyles.listRow}>
                    <span className={panelStyles.listRowText} title={reason}>
                      {reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p
            className={`${panelStyles.note} ${panelStyles.noteInfo}`}
            style={{ marginTop: 'var(--space-sm)' }}
          >
            {t(
              'Saving writes exactly this conversion — the same bytes the preview describes. ' +
                'Your PDF is not modified.'
            )}
          </p>
        </div>
      ) : (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t(
            'A preview is required before saving. Choose "Preview conversion" to convert the ' +
              'document and check the sheets; the save button unlocks once it has run.'
          )}
        </p>
      )}
    </>
  );
}
