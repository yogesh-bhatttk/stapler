/**
 * CNV-08 — PDF → Word (DOCX) options, and the mandatory preview.
 *
 * The preview is not a nicety here, it is the gate: the panel runs the whole
 * conversion, holds the finished bytes, and only then clears
 * `commit-gate`'s block on the action bar's primary CTA. Changing an option or
 * switching document throws the preview away and the gate closes again, because a
 * preview of a different file is worse than no preview at all (PLAN §5.5).
 */
import { FileType, RefreshCw } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { activeDoc } from '../../../core/store';
import { historyVersion } from '../../../core/history';
import { convertPdfToDocx, currentDocumentBytes } from '../../../core/operations';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  pdfToWordOptions,
  pdfToWordPreview,
  pdfToWordPreviewIsStale,
  resetPdfToWordPreview,
  setPdfToWordPreview
} from './pdf-to-word-state';

/** What each block kind is called in the preview's left-hand gutter. */
const KIND_LABEL: Record<string, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  table: 'Table',
  image: 'Image'
};

export function PdfToWordPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const options = pdfToWordOptions.value;
  const preview = pdfToWordPreview.value;

  // A preview belongs to one document *at one revision*. Opening another
  // document must not leave the save button unlocked over the previous
  // document's bytes — and neither must editing this one somewhere else (delete
  // a page in Organize, rotate one, crop, annotate) and coming back, which is
  // what a doc-id-only check used to allow. Reading `historyVersion.value` here
  // is also what subscribes this component, so the gate closes on the edit
  // rather than on the next unrelated re-render.
  void historyVersion.value;
  const stale = preview !== null && pdfToWordPreviewIsStale(doc?.id ?? null);
  useEffect(() => {
    if (stale) resetPdfToWordPreview();
  }, [stale]);

  if (!doc) return null;

  const handlePreview = () => {
    run({ label: 'Converting to Word', scope: 'convert.pdf-to-word' }, async job => {
      // Captured before the bytes are read, so an edit made *during* the
      // conversion still invalidates its result.
      const revision = historyVersion.value;
      const bytes = await currentDocumentBytes(job);
      const result = await convertPdfToDocx(
        bytes,
        { ...pdfToWordOptions.value, documentName: doc.name },
        job
      );
      setPdfToWordPreview(result, doc.id, revision);
      notify(
        'success',
        translate('Converted {pages} page(s). Review the preview, then save.', {
          pages: result.pageCount
        }),
        { detail: `${formatBytes(result.bytes.byteLength)} · ${result.outline.length} blocks` }
      );
    });
  };

  return (
    <>
      {/*
        No heading of its own: `OptionsPanel` already renders the tool's title as
        the panel's `<h1>`, and a second heading with the same words is a
        duplicate landmark for a screen reader rather than extra information. The
        badge stands alone, labelled so it is not read as a bare word.
      */}
      <div className={panelStyles.section}>
        <Badge variant="neutral" aria-label={t('This tool is in beta')}>
          {t('Beta')}
        </Badge>
      </div>

      <p className={panelStyles.description}>
        {t(
          'Produces an editable .docx with the paragraphs, headings, tables and images this ' +
            'PDF contains. Layout, fonts, columns and page breaks may differ from the ' +
            'original — this is a structural conversion, not a copy of the page.'
        )}
      </p>

      {/*
        The bold/italic claim is scoped rather than blanket, because the block
        model carries table cells as plain text (`blocks.ts`'s
        `{ kind: 'table'; rows: string[][] }`): a bold figure inside a cell
        arrives in the `.docx` as the right words in the right cell, unbolded.
        Promising "bold and italic are preserved" without that exception would be
        a claim the output does not honour.
      */}
      <p className={panelStyles.description}>
        {t(
          'Bold and italic are preserved in paragraphs and headings. Table cell text is ' +
            'preserved but its character formatting is not — a bold or italic cell arrives ' +
            'as plain text.'
        )}
      </p>

      <div className={panelStyles.section}>
        <Checkbox
          label={t('Include embedded images')}
          checked={options.includeImages}
          onChange={includeImages => {
            pdfToWordOptions.value = { ...options, includeImages };
            // The previewed file was built the other way round; it is no longer
            // what this panel is describing.
            resetPdfToWordPreview();
          }}
        />
      </div>

      <div className={panelStyles.section}>
        <Button variant="secondary" icon={preview ? RefreshCw : FileType} onClick={handlePreview}>
          {preview ? t('Convert again') : t('Preview conversion')}
        </Button>
      </div>

      {preview ? (
        <div className={panelStyles.section}>
          <p className="text-small" style={{ margin: '0 0 var(--space-xs)', fontWeight: 600 }}>
            {t('Preview')} · {preview.pageCount} {preview.pageCount === 1 ? t('page') : t('pages')}{' '}
            · {preview.outline.length} {t('blocks')}
            {preview.imageCount > 0 ? ` · ${preview.imageCount} ${t('images')}` : ''}
          </p>

          <ol
            className={panelStyles.list}
            aria-label={t('Blocks that will be written to the Word document')}
          >
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
                  p{item.pageIndex + 1} ·{' '}
                  {item.kind === 'heading'
                    ? `H${item.level ?? 2}`
                    : (KIND_LABEL[item.kind] ?? item.kind)}
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

          {/*
            Shown only when the conversion actually produced a table, so it reads
            as a fact about *this* output rather than boilerplate.
          */}
          {preview.outline.some(item => item.kind === 'table') && (
            <p className={panelStyles.note} style={{ marginTop: 'var(--space-sm)' }}>
              {t(
                'Bold and italic inside a table cell were not carried across: the cell text is ' +
                  'in the Word document, its character formatting is not.'
              )}
            </p>
          )}

          {preview.skipped.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <p className={panelStyles.note}>
                {t('Some content was left out of the Word document:')}
              </p>
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
              'document and check the result; the save button unlocks once it has run.'
          )}
        </p>
      )}
    </>
  );
}
