/**
 * CNV-09 — Word (DOCX) → PDF options, and the mandatory preview.
 *
 * The preview is the gate, not a label, exactly as in `PdfToWordPanel`: the panel
 * runs the whole conversion, holds the finished bytes, and only then clears
 * `commit-gate`'s block on the action bar's primary CTA. Choosing a different
 * file or changing the page size throws the preview away and the gate closes
 * again, because a preview of a different file is worse than no preview at all
 * (PLAN §5.5).
 */
import { FilePlus, RefreshCw, Upload } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { DOCX_ONLY } from '../../../platform/index';
import { convertDocxToPdf } from '../../../core/operations';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  setWordToPdfOptions,
  setWordToPdfPreview,
  setWordToPdfSource,
  wordToPdfInputRevision,
  wordToPdfOptions,
  wordToPdfPreview,
  wordToPdfPreviewIsStale,
  wordToPdfSource
} from './word-to-pdf-state';

/**
 * Every limitation of this converter, in the panel the user actually reads.
 *
 * The same eight are listed in `docs/TICKETS.md`'s CNV-09 entry, in the same
 * order, and this list is why: a limitation stated only in a ticket, or only in a
 * toast that fires after the fact, is not disclosed to the person deciding
 * whether to trust the output. CNV-09's second review pass found four of the six
 * limitations then documented reachable only that way, and two more that were not
 * documented at all.
 */
const LIMITATIONS = [
  'Word’s own pagination, fonts, columns, headers, footers and footnotes are not reproduced — ' +
    'page size and 1" margins are chosen here, not read from the document.',
  'Text is drawn in Helvetica. Characters outside the Latin-1 set (CJK, Cyrillic, most Arabic ' +
    'and Hebrew) are replaced with "?", and the conversion says so when it happens.',
  'Only PNG and JPEG images are embedded. Pasted vector art (EMF/WMF, as Word stores it) is ' +
    'listed as left out rather than dropped quietly.',
  'Underline, superscript and subscript are drawn as plain text.',
  'An image inside a table cell is left out: cells hold text only.',
  'A table split across pages does not repeat its header row, and a row taller than a page is ' +
    'allowed to run over rather than have its text cut off.',
  'Empty spacer paragraphs are dropped, so vertical spacing will not match line for line.',
  'Lists nested more than eight levels deep are flattened to eight: their text is all there, ' +
    'their deepest indentation is not.'
];

/** What each block kind is called in the preview's left-hand gutter. */
const KIND_LABEL: Record<string, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  'list-item': 'List item',
  table: 'Table',
  image: 'Image'
};

export function WordToPdfPanel() {
  const t = useTranslation();
  const { run } = useJob();
  const options = wordToPdfOptions.value;
  const source = wordToPdfSource.value;
  const preview = wordToPdfPreview.value;

  // Reading the revision here is what subscribes this component to it, so the
  // gate re-closes on the change itself rather than on the next unrelated
  // re-render — the same subscription `PdfToWordPanel` makes on `historyVersion`.
  void wordToPdfInputRevision.value;
  const stale = preview !== null && wordToPdfPreviewIsStale();

  const chooseFile = async () => {
    const opened = await platform.openFiles({ accept: DOCX_ONLY });
    if (opened.length === 0) return;
    const file = await opened[0].getFile();
    if (!/\.docx$/i.test(file.name)) {
      notify('warning', translate('That is not a .docx file.'), {
        detail:
          'This converter reads Word’s modern .docx format. A legacy .doc, or a document ' +
          'exported as .rtf or .odt, has to be saved as .docx first.'
      });
      return;
    }
    setWordToPdfSource(file);
  };

  const handlePreview = () => {
    const file = wordToPdfSource.value;
    if (!file) return;
    run({ label: 'Converting to PDF', scope: 'convert.word-to-pdf' }, async job => {
      // Captured before the bytes are read, so a change made *during* the
      // conversion still invalidates its result.
      const revision = wordToPdfInputRevision.value;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await convertDocxToPdf(
        bytes,
        { ...wordToPdfOptions.value, documentName: file.name.replace(/\.docx$/i, '') },
        job
      );
      setWordToPdfPreview(result, file, revision);
      notify(
        'success',
        translate('Converted to {pages} page(s). Review the preview, then save.', {
          pages: result.pageCount
        }),
        { detail: `${formatBytes(result.bytes.byteLength)} · ${result.outline.length} blocks` }
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
          'Produces a PDF with the headings, paragraphs, lists, tables and images this Word ' +
            'document contains. Word’s own pagination, fonts, columns, headers and footers are ' +
            'not reproduced — this is a structural conversion, not a copy of the page.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'Bold, italic and hyperlinks are preserved, in table cells as well as in body text. ' +
            'Your .docx is never modified, and nothing leaves this browser.'
        )}
      </p>

      {/*
        Every limitation in one place, before the conversion runs — not spread
        between a toast, the preview's notes and a ticket. `aria-label` names the
        list so a screen reader reaching it out of context still knows what it is.
      */}
      <div className={panelStyles.section}>
        <div className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          <p style={{ margin: 0 }}>{t('What this converter does not carry across:')}</p>
          <ul
            className={panelStyles.proseList}
            aria-label={t('What this converter does not carry across')}
          >
            {LIMITATIONS.map((limitation, index) => (
              <li key={index}>{t(limitation)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Button variant="secondary" icon={Upload} onClick={chooseFile}>
          {source ? t('Choose a different .docx') : t('Choose a .docx file')}
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
              setWordToPdfOptions({ ...options, pageSize: value as typeof options.pageSize })
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
            {t('Preview')} · {preview.pageCount} {preview.pageCount === 1 ? t('page') : t('pages')}{' '}
            · {preview.outline.length} {t('blocks')}
            {preview.imageCount > 0 ? ` · ${preview.imageCount} ${t('images')}` : ''}
          </p>

          <ol className={panelStyles.list} aria-label={t('Blocks that will be written to the PDF')}>
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

          {/*
            Kept apart from the list above on purpose. These are the Word
            reader's own remarks about the source file — an unrecognised
            paragraph style, most often — and a style that fell back to a
            default is not content that went missing. Merging the two counted
            them as losses in the save toast and told the user the conversion
            had dropped things it had not.
          */}
          {preview.warnings.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <p className={panelStyles.note}>
                {t(
                  'Notes from reading the Word document (these are not missing content — usually ' +
                    'a style that fell back to a default):'
                )}
              </p>
              <ul
                className={panelStyles.list}
                style={{ marginTop: 'var(--space-xs)' }}
                aria-label={t('Notes from reading the Word document')}
              >
                {preview.warnings.map((warning, index) => (
                  <li key={index} className={panelStyles.listRow}>
                    <span className={panelStyles.listRowText} title={warning}>
                      {warning}
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
                'Your .docx is not modified.'
            )}
          </p>
        </div>
      ) : (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {source
            ? t(
                'A preview is required before saving. Choose "Preview conversion" to convert the ' +
                  'document and check the result; the save button unlocks once it has run.'
              )
            : t('Choose a .docx file to convert. The save button unlocks after a preview has run.')}
        </p>
      )}
    </>
  );
}
