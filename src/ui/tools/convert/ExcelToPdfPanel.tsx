/**
 * CNV-11 — Excel (XLSX) → PDF options, and the mandatory preview.
 *
 * The preview is the gate, not a label, exactly as in `WordToPdfPanel`: the panel
 * runs the whole conversion, holds the finished bytes, and only then clears
 * `commit-gate`'s block on the action bar's primary CTA. Choosing a different
 * file or changing the page size throws the preview away and the gate closes
 * again, because a preview of a different file is worse than no preview at all
 * (PLAN §5.5).
 */
import { FilePlus, RefreshCw, Upload } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { XLSX_ONLY } from '../../../platform/index';
import { convertXlsxToPdf } from '../../../core/operations';
import { EXCEL_LIMITATIONS } from '../../../core/convert/xlsx-reader';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  excelToPdfInputRevision,
  excelToPdfOptions,
  excelToPdfPreview,
  excelToPdfPreviewIsStale,
  excelToPdfSource,
  setExcelToPdfOptions,
  setExcelToPdfPreview,
  setExcelToPdfSource
} from './excel-to-pdf-state';

/**
 * What each block kind is called in the preview's left-hand gutter.
 *
 * A spreadsheet only ever produces three of the five: a heading naming the
 * sheet, the grid itself, and a paragraph for a sheet that is empty or for a
 * band's column range.
 */
const KIND_LABEL: Record<string, string> = {
  heading: 'Sheet',
  paragraph: 'Note',
  'list-item': 'List item',
  table: 'Grid',
  image: 'Image'
};

export function ExcelToPdfPanel() {
  const t = useTranslation();
  const { run } = useJob();
  const options = excelToPdfOptions.value;
  const source = excelToPdfSource.value;
  const preview = excelToPdfPreview.value;

  // Reading the revision here is what subscribes this component to it, so the
  // gate re-closes on the change itself rather than on the next unrelated
  // re-render — the same subscription `WordToPdfPanel` makes.
  void excelToPdfInputRevision.value;
  const stale = preview !== null && excelToPdfPreviewIsStale();

  const chooseFile = async () => {
    const opened = await platform.openFiles({ accept: XLSX_ONLY });
    if (opened.length === 0) return;
    const file = await opened[0].getFile();
    if (!/\.xlsx$/i.test(file.name)) {
      notify('warning', translate('That is not an .xlsx file.'), {
        detail:
          'This converter reads Excel’s modern .xlsx format. A legacy .xls, a macro-enabled ' +
          '.xlsm, or a .csv has to be saved as .xlsx first.'
      });
      return;
    }
    setExcelToPdfSource(file);
  };

  const handlePreview = () => {
    const file = excelToPdfSource.value;
    if (!file) return;
    run({ label: 'Converting to PDF', scope: 'convert.excel-to-pdf' }, async job => {
      // Captured before the bytes are read, so a change made *during* the
      // conversion still invalidates its result.
      const revision = excelToPdfInputRevision.value;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await convertXlsxToPdf(
        bytes,
        { ...excelToPdfOptions.value, documentName: file.name.replace(/\.xlsx$/i, '') },
        job
      );
      setExcelToPdfPreview(result, file, revision);
      notify(
        'success',
        translate(
          'Converted {sheets} sheet(s) to {pages} page(s). Review the preview, then save.',
          {
            sheets: result.sheets.length,
            pages: result.pageCount
          }
        ),
        { detail: `${formatBytes(result.bytes.byteLength)} · ${result.outline.length} sections` }
      );
      if (result.hadUnsupportedCharacters) {
        notify('warning', translate('Some characters could not be represented.'), {
          detail:
            'This export uses a fixed set of Latin fonts and replaced unsupported characters ' +
            '(e.g. CJK, Cyrillic, Arabic) with "?". Check the affected text before sharing it.',
          timeout: 0
        });
      }
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
          'Draws every visible sheet of this workbook as a grid of cells, one section per ' +
            'sheet, paginated by row count. Excel’s own print setup — paper size, scaling, ' +
            'print areas, repeated title rows — is not read; this is a structural conversion, ' +
            'not a copy of Excel’s printed page.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'Each cell shows the value Excel last displayed, so number and date formats are ' +
            'preserved. Your .xlsx is never modified, and nothing leaves this browser.'
        )}
      </p>

      {/*
        Every limitation in one place, before the conversion runs — not spread
        between a toast, the preview's notes and a ticket. The list itself lives
        in `core/convert/xlsx-reader.ts` so the panel and the reader cannot state
        different ones. `aria-label` names the list so a screen reader reaching
        it out of context still knows what it is.
      */}
      <div className={panelStyles.section}>
        <div className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          <p style={{ margin: 0 }}>{t('What this converter does not carry across:')}</p>
          <ul
            className={panelStyles.proseList}
            aria-label={t('What this converter does not carry across')}
          >
            {EXCEL_LIMITATIONS.map((limitation, index) => (
              <li key={index}>{t(limitation)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Button variant="secondary" icon={Upload} onClick={chooseFile}>
          {source ? t('Choose a different .xlsx') : t('Choose an .xlsx file')}
        </Button>
        {source && (
          <p className={panelStyles.note} style={{ marginTop: 'var(--space-xs)' }}>
            {source.name} · {formatBytes(source.size)}
          </p>
        )}
      </div>

      <Field label={t('Page size')}>
        {id => (
          <Select
            id={id}
            value={options.pageSize as string}
            onChange={value =>
              setExcelToPdfOptions({ ...options, pageSize: value as typeof options.pageSize })
            }
            options={[
              { value: 'a4', label: t('A4') },
              { value: 'letter', label: t('US Letter') }
            ]}
          />
        )}
      </Field>

      <div className={panelStyles.section}>
        <Button
          variant="secondary"
          icon={preview ? RefreshCw : FilePlus}
          disabled={!source}
          onClick={handlePreview}
        >
          {preview ? t('Convert again') : t('Preview conversion')}
        </Button>
      </div>

      {preview && !stale ? (
        <div className={panelStyles.section}>
          <p className="text-small" style={{ margin: '0 0 var(--space-xs)', fontWeight: 600 }}>
            {t('Preview')} · {preview.sheets.length}{' '}
            {preview.sheets.length === 1 ? t('sheet') : t('sheets')} · {preview.pageCount}{' '}
            {preview.pageCount === 1 ? t('page') : t('pages')}
          </p>

          <ol className={panelStyles.list} aria-label={t('Sheets that will be drawn into the PDF')}>
            {preview.outline.map((item, index) => (
              <li key={index} className={panelStyles.listRow}>
                <span
                  className="text-micro"
                  style={{
                    flex: '0 0 auto',
                    minWidth: '72px',
                    color: 'var(--ink-subtle)',
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  p{item.pageIndex + 1} · {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                <span
                  className={panelStyles.listRowText}
                  style={{
                    color: item.kind === 'heading' ? 'var(--ink)' : 'var(--ink-muted)',
                    fontWeight: item.kind === 'heading' ? 600 : 400
                  }}
                  title={item.text}
                >
                  {item.text}
                </span>
              </li>
            ))}
          </ol>

          {preview.notes.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <p className={panelStyles.note}>{t('Some content was left out of the PDF:')}</p>
              <ul
                className={panelStyles.list}
                style={{ marginTop: 'var(--space-xs)' }}
                aria-label={t('Content left out of the PDF')}
              >
                {preview.notes.map((reason, index) => (
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
                'Your .xlsx is not modified.'
            )}
          </p>
        </div>
      ) : (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {source
            ? t(
                'A preview is required before saving. Choose "Preview conversion" to convert the ' +
                  'workbook and check the result; the save button unlocks once it has run.'
              )
            : t(
                'Choose an .xlsx file to convert. The save button unlocks after a preview has run.'
              )}
        </p>
      )}
    </>
  );
}
