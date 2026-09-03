/**
 * CNV-13 — PowerPoint (PPTX) → PDF options, and the mandatory preview.
 *
 * The preview is the gate, not a label, exactly as in `ExcelToPdfPanel`: the
 * panel runs the whole conversion, holds the finished bytes, and only then
 * clears `commit-gate`'s block on the action bar's primary CTA. Choosing a
 * different file or changing the page fit throws the preview away and the gate
 * closes again, because a preview of a different file is worse than no preview
 * at all (PLAN §5.5).
 */
import { FilePlus, RefreshCw, Upload } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { PPTX_ONLY } from '../../../platform/index';
import { convertPptxToPdf } from '../../../core/operations';
import { BLANK_SLIDE_LABEL, PPT_LIMITATIONS } from '../../../core/convert/pptx-slides';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import { formatBytes } from '../../components/Feedback';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  pptToPdfInputRevision,
  pptToPdfOptions,
  pptToPdfPreview,
  pptToPdfPreviewIsStale,
  pptToPdfSource,
  setPptToPdfOptions,
  setPptToPdfPreview,
  setPptToPdfSource
} from './ppt-to-pdf-state';

/** Inches, to one decimal — how PowerPoint itself states a slide's size. */
function inches(points: number): string {
  return (Math.round((points / 72) * 10) / 10).toString();
}

export function PptToPdfPanel() {
  const t = useTranslation();
  const { run } = useJob();
  const options = pptToPdfOptions.value;
  const source = pptToPdfSource.value;
  const preview = pptToPdfPreview.value;

  // Reading the revision here is what subscribes this component to it, so the
  // gate re-closes on the change itself rather than on the next unrelated
  // re-render — the same subscription `ExcelToPdfPanel` makes.
  void pptToPdfInputRevision.value;
  const stale = preview !== null && pptToPdfPreviewIsStale();

  const chooseFile = async () => {
    const opened = await platform.openFiles({ accept: PPTX_ONLY });
    if (opened.length === 0) return;
    const file = await opened[0].getFile();
    if (!/\.pptx$/i.test(file.name)) {
      notify('warning', translate('That is not a .pptx file.'), {
        detail:
          'This converter reads PowerPoint’s modern .pptx format. A legacy .ppt, a ' +
          'macro-enabled .pptm, or a slideshow .ppsx has to be saved as .pptx first.'
      });
      return;
    }
    setPptToPdfSource(file);
  };

  const handlePreview = () => {
    const file = pptToPdfSource.value;
    if (!file) return;
    run({ label: 'Converting to PDF', scope: 'convert.ppt-to-pdf' }, async job => {
      // Captured before the bytes are read, so a change made *during* the
      // conversion still invalidates its result.
      const revision = pptToPdfInputRevision.value;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await convertPptxToPdf(
        bytes,
        { ...pptToPdfOptions.value, documentName: file.name.replace(/\.pptx$/i, '') },
        job
      );
      setPptToPdfPreview(result, file, revision);
      notify(
        'success',
        translate(
          'Converted {slides} slide(s) to {pages} page(s). Review the preview, then save.',
          {
            slides: result.slideCount,
            pages: result.pageCount
          }
        ),
        {
          detail:
            `${formatBytes(result.bytes.byteLength)} · ${result.imageCount} image(s) · ` +
            `${inches(result.slideWidth)} × ${inches(result.slideHeight)} in`
        }
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
          'Draws one PDF page per slide, with each shape’s text, picture and table where the ' +
            'deck positions it. Slide transitions, animations and speaker notes are not ' +
            'reproduced — a PDF page has no notion of any of them.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'This is a structural conversion, not a picture of what PowerPoint renders. Your ' +
            '.pptx is never modified, and nothing leaves this browser.'
        )}
      </p>

      {/*
        Every limitation in one place, before the conversion runs — not spread
        between a toast, the preview's notes and a ticket. The list itself lives
        in `core/convert/pptx-slides.ts` so the panel and the converter cannot
        state different ones. `aria-label` names the list so a screen reader
        reaching it out of context still knows what it is.
      */}
      <div className={panelStyles.section}>
        <div className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          <p style={{ margin: 0 }}>{t('What this converter does not carry across:')}</p>
          <ul
            className={panelStyles.proseList}
            aria-label={t('What this converter does not carry across')}
          >
            {PPT_LIMITATIONS.map((limitation, index) => (
              <li key={index}>{t(limitation)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Button variant="secondary" icon={Upload} onClick={chooseFile}>
          {source ? t('Choose a different .pptx') : t('Choose a .pptx file')}
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
            value={options.pageSize}
            onChange={value =>
              setPptToPdfOptions({ ...options, pageSize: value as typeof options.pageSize })
            }
            options={[
              { value: 'slide', label: t('Match the slide size') },
              { value: 'a4', label: t('A4') },
              { value: 'letter', label: t('US Letter') }
            ]}
          />
        )}
      </Field>

      <p className={panelStyles.note}>
        {t(
          'A paper size fits each slide inside the page and centres it, keeping its shape — so ' +
            'a widescreen deck gets a band above and below rather than being stretched.'
        )}
      </p>

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
            {t('Preview')} · {preview.slideCount}{' '}
            {preview.slideCount === 1 ? t('slide') : t('slides')} · {preview.pageCount}{' '}
            {preview.pageCount === 1 ? t('page') : t('pages')}
          </p>

          <ol className={panelStyles.list} aria-label={t('Slides that will be drawn into the PDF')}>
            {preview.outline.map((item, index) => {
              const slide = preview.slides[index];
              return (
                <li key={index} className={panelStyles.listRow}>
                  <span
                    className="text-micro"
                    style={{
                      flex: '0 0 auto',
                      minWidth: '92px',
                      color: 'var(--ink-subtle)',
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    p{item.pageIndex + 1} · {t('Slide')} {slide ? slide.number : index + 1}
                  </span>
                  <span
                    className={panelStyles.listRowText}
                    style={{ color: 'var(--ink-muted)' }}
                    title={item.text}
                  >
                    {item.text}
                    {/*
                      A page that will come out blank says so on its own row.
                      The converter already knows this at preview time
                      (`SlideSummary.empty`), and the preview is this tool's
                      stated safety mechanism — showing nothing here would mean
                      the user is only protected in the all-or-nothing case the
                      refusal covers, and a deck with three inherited-placeholder
                      slides among four is the commoner shape.
                    */}
                    {slide?.empty ? (
                      <span style={{ color: 'var(--warning)' }}> · {t(BLANK_SLIDE_LABEL)}</span>
                    ) : null}
                    {slide && (slide.images > 0 || slide.tables > 0) ? (
                      <span style={{ color: 'var(--ink-subtle)' }}>
                        {' '}
                        ·{' '}
                        {[
                          slide.images > 0
                            ? `${slide.images} ${slide.images === 1 ? t('image') : t('images')}`
                            : null,
                          slide.tables > 0
                            ? `${slide.tables} ${slide.tables === 1 ? t('table') : t('tables')}`
                            : null
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
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
                'Your .pptx is not modified.'
            )}
          </p>
        </div>
      ) : (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {source
            ? t(
                'A preview is required before saving. Choose "Preview conversion" to convert the ' +
                  'presentation and check the result; the save button unlocks once it has run.'
              )
            : t('Choose a .pptx file to convert. The save button unlocks after a preview has run.')}
        </p>
      )}
    </>
  );
}
