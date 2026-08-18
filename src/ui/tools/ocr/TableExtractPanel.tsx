import { translate } from '../../../core/i18n';
import { useState } from 'preact/hooks';
import { Download, Table, RefreshCw } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, extractPageTextItems } from '../../../core/operations';
import { notify } from '../../../core/notify';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import {
  extractTableFromPage,
  exportTableToCsv,
  exportTableToTsv,
  exportTableToXlsx,
  TableGridData
} from '../../../core/ocr/table-extract';
import {
  tableExtractPageIndex,
  tableExtractRows,
  tableExtractFormat,
  resetTableExtract
} from './table-extract-state';

export function TableExtractPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();

  // Page number and the edited grid live in signals, not component state, so the
  // action bar's primary CTA exports the table the user is actually looking at.
  const pageIndex = tableExtractPageIndex.value;
  const [grid, setGrid] = useState<TableGridData | null>(null);
  const editedRows = tableExtractRows.value ?? [];
  const setEditedRows = (rows: string[][]) => {
    tableExtractRows.value = rows;
  };

  if (!doc) return null;

  const pageOptions = doc.pages.map((_, idx) => ({
    value: String(idx),
    label: `Page ${idx + 1}`
  }));

  const handleExtract = () => {
    run({ label: 'Extracting table', scope: 'extract' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const items = await extractPageTextItems(bytes, pageIndex);
      const extracted = extractTableFromPage(items);

      if (extracted.rows.length === 0) {
        notify(
          'warning',
          translate('No structured table data found on page {page}.', { page: pageIndex + 1 })
        );
      }

      setGrid(extracted);
      setEditedRows(extracted.rows.map(row => [...row]));
    });
  };

  const handleCellChange = (rIdx: number, cIdx: number, value: string) => {
    const updated = editedRows.map(row => [...row]);
    if (updated[rIdx]) {
      updated[rIdx][cIdx] = value;
      setEditedRows(updated);
    }
  };

  const getExportGrid = (): TableGridData => {
    return {
      rows: editedRows,
      headers: editedRows.length > 0 ? editedRows[0] : [],
      rowCount: editedRows.length,
      columnCount: editedRows.length > 0 ? editedRows[0].length : 0
    };
  };

  const handleExportCsv = async () => {
    if (!grid || editedRows.length === 0) return;
    tableExtractFormat.value = 'csv';
    const csv = exportTableToCsv(getExportGrid());
    const stem = doc.name.replace(/\.[^.]+$/, '');
    await platform.saveFileAs(
      new TextEncoder().encode(csv),
      `${stem}-page${pageIndex + 1}-table.csv`
    );
    notify('success', translate('Exported CSV file.'));
  };

  const handleExportTsv = async () => {
    if (!grid || editedRows.length === 0) return;
    tableExtractFormat.value = 'tsv';
    const tsv = exportTableToTsv(getExportGrid());
    const stem = doc.name.replace(/\.[^.]+$/, '');
    await platform.saveFileAs(
      new TextEncoder().encode(tsv),
      `${stem}-page${pageIndex + 1}-table.tsv`
    );
    notify('success', translate('Exported TSV file.'));
  };

  const handleExportXlsx = async () => {
    if (!grid || editedRows.length === 0) return;
    tableExtractFormat.value = 'xlsx';
    const xlsx = exportTableToXlsx(getExportGrid());
    const stem = doc.name.replace(/\.[^.]+$/, '');
    await platform.saveFileAs(xlsx, `${stem}-page${pageIndex + 1}-table.xlsx`);
    notify('success', translate('Exported XLSX file.'));
  };

  const hasPreview = grid !== null && editedRows.length > 0;

  return (
    <>
      <div
        className={panelStyles.section}
        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        <h2 className="text-section" style={{ margin: 0 }}>
          {t('Table extraction')}
        </h2>
        <Badge variant="neutral">(Beta)</Badge>
      </div>

      <p className={panelStyles.description}>
        {t('Infer rows and columns from page text positions and export to spreadsheet formats.')}
      </p>

      <Field label={t('Page to extract')}>
        {id => (
          <Select
            id={id}
            value={String(pageIndex)}
            options={pageOptions}
            onChange={val => {
              tableExtractPageIndex.value = Number(val);
              setGrid(null);
              resetTableExtract();
            }}
          />
        )}
      </Field>

      <Button variant="secondary" icon={Table} onClick={handleExtract}>
        {t('Preview Table')}
      </Button>

      {hasPreview ? (
        <div className={panelStyles.section} style={{ marginTop: '16px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px'
            }}
          >
            <span className="text-small" style={{ fontWeight: 600 }}>
              {t('Interactive Preview Grid')} ({editedRows.length} rows,{' '}
              {editedRows[0]?.length || 0} cols)
            </span>
            <Button
              variant="tertiary"
              size="compact"
              icon={RefreshCw}
              onClick={() => {
                if (grid) setEditedRows(grid.rows.map(r => [...r]));
              }}
            >
              {t('Reset')}
            </Button>
          </div>

          <div
            style={{
              maxHeight: '260px',
              overflow: 'auto',
              border: '1px solid var(--hairline-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-1)'
            }}
          >
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '12px',
                fontFamily: 'var(--font-sans)'
              }}
            >
              <thead>
                <tr
                  style={{
                    background: 'var(--surface-3)',
                    borderBottom: '1px solid var(--hairline-strong)'
                  }}
                >
                  <th style={{ padding: '4px 8px', textAlign: 'center', width: '32px' }}>#</th>
                  {editedRows[0]?.map((_, cIdx) => (
                    <th
                      key={cIdx}
                      style={{
                        padding: '4px 8px',
                        textAlign: 'left',
                        borderLeft: '1px solid var(--hairline-strong)',
                        fontWeight: 600
                      }}
                    >
                      Col {cIdx + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {editedRows.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    style={{
                      borderBottom: '1px solid var(--hairline)',
                      background: rIdx % 2 === 0 ? 'transparent' : 'var(--surface-2)'
                    }}
                  >
                    <td
                      style={{
                        padding: '4px 8px',
                        textAlign: 'center',
                        color: 'var(--ink-subtle)',
                        fontWeight: 500
                      }}
                    >
                      {rIdx + 1}
                    </td>
                    {row.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        style={{
                          padding: '2px 4px',
                          borderLeft: '1px solid var(--hairline)'
                        }}
                      >
                        <input
                          type="text"
                          value={cell}
                          onChange={e =>
                            handleCellChange(rIdx, cIdx, (e.target as HTMLInputElement).value)
                          }
                          style={{
                            width: '100%',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--ink)',
                            fontSize: '12px',
                            fontFamily: 'inherit',
                            padding: '2px 4px'
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            <Button variant="tertiary" size="compact" icon={Download} onClick={handleExportCsv}>
              {t('Export CSV')}
            </Button>
            <Button variant="tertiary" size="compact" icon={Download} onClick={handleExportTsv}>
              {t('Export TSV')}
            </Button>
            <Button variant="tertiary" size="compact" icon={Download} onClick={handleExportXlsx}>
              {t('Export XLSX')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={panelStyles.section} style={{ marginTop: '16px' }}>
          <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
            {t(
              "Mandatory preview grid: click 'Preview Table' to inspect and edit rows and columns before export."
            )}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <Button variant="tertiary" size="compact" disabled icon={Download}>
              {t('Export CSV')}
            </Button>
            <Button variant="tertiary" size="compact" disabled icon={Download}>
              {t('Export TSV')}
            </Button>
            <Button variant="tertiary" size="compact" disabled icon={Download}>
              {t('Export XLSX')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
