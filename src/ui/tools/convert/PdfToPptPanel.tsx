/**
 * CNV-12 — PDF → PowerPoint (PPTX) options, and the mandatory preview.
 *
 * The preview is not a nicety here, it is the gate: the panel runs the whole
 * conversion, holds the finished bytes, and only then clears `commit-gate`'s
 * block on the action bar's primary CTA. Changing an option, editing the
 * document or switching document throws the preview away and the gate closes
 * again, because a preview of a different file is worse than no preview at all
 * (PLAN §5.5).
 *
 * The copy in this panel is longer than any of its four siblings' on purpose.
 * This is the widest fidelity gap of the six conversion tools and the ticket
 * requires the beta copy to say so plainly, so the limitation list is rendered in
 * full *before* the conversion runs — from `slides.ts`'s `PPTX_LIMITATIONS`, so
 * the panel and the converter cannot state different limitations.
 */
import { Presentation, RefreshCw } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { activeDoc } from '../../../core/store';
import { historyVersion } from '../../../core/history';
import { convertPdfToPptx, currentDocumentBytes } from '../../../core/operations';
import { PPTX_LIMITATIONS } from '../../../core/convert/slides';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  pdfToPptOptions,
  pdfToPptPreview,
  pdfToPptPreviewIsStale,
  resetPdfToPptPreview,
  setPdfToPptPreview
} from './pdf-to-ppt-state';

/** Points → inches, for stating the deck's real slide size in the preview. */
function inches(points: number): string {
  return (Math.round((points / 72) * 100) / 100).toString();
}

export function PdfToPptPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const options = pdfToPptOptions.value;
  const preview = pdfToPptPreview.value;

  // A preview belongs to one document *at one revision*. Opening another
  // document must not leave the save button unlocked over the previous
  // document's bytes — and neither must editing this one somewhere else (delete
  // a page in Organize, rotate one, crop, annotate) and coming back, which a
  // doc-id-only check would allow. Reading `historyVersion.value` here is also
  // what subscribes this component, so the gate closes on the edit rather than
  // on the next unrelated re-render.
  void historyVersion.value;
  const stale = preview !== null && pdfToPptPreviewIsStale(doc?.id ?? null);
  useEffect(() => {
    if (stale) resetPdfToPptPreview();
  }, [stale]);

  if (!doc) return null;

  const handlePreview = () => {
    run({ label: 'Converting to PowerPoint', scope: 'convert.pdf-to-ppt' }, async job => {
      // Captured before the bytes are read, so an edit made *during* the
      // conversion still invalidates its result.
      const revision = historyVersion.value;
      const bytes = await currentDocumentBytes(job);
      const result = await convertPdfToPptx(
        bytes,
        { ...pdfToPptOptions.value, documentName: doc.name },
        job
      );
      setPdfToPptPreview(result, doc.id, revision);
      notify(
        'success',
        translate('Built {slides} slide(s) from {pages} page(s). Review the preview, then save.', {
          slides: result.slideCount,
          pages: result.pageCount
        }),
        {
          detail:
            `${formatBytes(result.bytes.byteLength)} · ${result.textBoxCount} text box(es) · ` +
            `${result.imageCount} image(s)`
        }
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
          'Makes one slide per page and places that page’s lines of text and embedded images ' +
            'where the page drew them. What you get is a picture of the page assembled out of ' +
            'movable boxes — not an editable presentation. Nothing reflows, nothing is grouped, ' +
            'and there is no outline.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'This is the least faithful of Stapler’s converters, and the gap is wider than “fonts ' +
            'may differ”. Read the list below before you convert, then check the preview.'
        )}
      </p>

      {/*
        `proseList` rather than `list`/`listRow`, which is CNV-11's presentation
        for the same kind of content and the right one here for a reason: a
        `listRow` truncates to one line with the full text in a `title`
        attribute, and a list the ticket requires the user to *read* must not be
        behind eleven tooltips.
      */}
      <div className={panelStyles.section}>
        <div className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          <p style={{ margin: 0, fontWeight: 600 }}>{t('What this conversion does not do')}</p>
          <ul className={panelStyles.proseList} aria-label={t('Known limits of this conversion')}>
            {PPTX_LIMITATIONS.map((limitation, index) => (
              <li key={index}>{t(limitation)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Checkbox
          label={t('Place page text')}
          checked={options.includeText}
          onChange={includeText => {
            pdfToPptOptions.value = { ...options, includeText };
            // The previewed file was built the other way round; it is no longer
            // what this panel is describing.
            resetPdfToPptPreview();
          }}
        />
        <p className={panelStyles.note} style={{ marginTop: 'var(--space-xs)' }}>
          {t(
            'One text box per line of text. Switch it off for an OCR’d scan, where the invisible ' +
              'text layer would otherwise appear as black type over the page image.'
          )}
        </p>
      </div>

      <div className={panelStyles.section}>
        <Checkbox
          label={t('Place embedded images')}
          checked={options.includeImages}
          onChange={includeImages => {
            pdfToPptOptions.value = { ...options, includeImages };
            resetPdfToPptPreview();
          }}
        />
        <p className={panelStyles.note} style={{ marginTop: 'var(--space-xs)' }}>
          {t(
            'The PDF’s own image bytes, never re-encoded, placed at the rectangle the page draws ' +
              'them at. Anything PowerPoint cannot hold is named in the preview and left out.'
          )}
        </p>
      </div>

      <div className={panelStyles.section}>
        <Button
          variant="secondary"
          icon={preview ? RefreshCw : Presentation}
          onClick={handlePreview}
        >
          {preview ? t('Convert again') : t('Preview conversion')}
        </Button>
      </div>

      {preview ? (
        <div className={panelStyles.section}>
          <p className="text-small" style={{ margin: '0 0 var(--space-xs)', fontWeight: 600 }}>
            {t('Preview')} · {preview.slideCount}{' '}
            {preview.slideCount === 1 ? t('slide') : t('slides')} · {preview.textBoxCount}{' '}
            {preview.textBoxCount === 1 ? t('text box') : t('text boxes')}
            {preview.imageCount > 0 ? ` · ${preview.imageCount} ${t('images')}` : ''}
          </p>
          <p className={panelStyles.note} style={{ margin: '0 0 var(--space-xs)' }}>
            {t('Slide size: {width} × {height} in', {
              width: inches(preview.slideWidth),
              height: inches(preview.slideHeight)
            })}
          </p>

          <ol
            className={panelStyles.list}
            aria-label={t('Slides that will be written to the deck')}
          >
            {preview.outline.map(item => (
              <li key={item.slideNumber} className={panelStyles.listRow}>
                <span
                  className="text-micro"
                  style={{
                    flex: '0 0 auto',
                    minWidth: '96px',
                    color: 'var(--ink-subtle)',
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {t('Slide')} {item.slideNumber} · p{item.pageIndex + 1}
                </span>
                <span
                  className={panelStyles.listRowText}
                  style={{ color: 'var(--ink-muted)' }}
                  title={item.text}
                >
                  {item.textBoxCount} {item.textBoxCount === 1 ? t('text box') : t('text boxes')}
                  {item.imageCount > 0
                    ? ` · ${item.imageCount} ${item.imageCount === 1 ? t('image') : t('images')}`
                    : ''}
                  {item.text ? ` · ${item.text}` : ` · ${t('nothing was placed on this slide')}`}
                </span>
              </li>
            ))}
          </ol>

          {preview.notes.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <p className={panelStyles.note}>{t('Some content was left out of the deck:')}</p>
              <ul className={panelStyles.list} style={{ marginTop: 'var(--space-xs)' }}>
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
                'Your PDF is not modified.'
            )}
          </p>
        </div>
      ) : (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t(
            'A preview is required before saving. Choose "Preview conversion" to convert the ' +
              'document and check the slides; the save button unlocks once it has run.'
          )}
        </p>
      )}
    </>
  );
}
