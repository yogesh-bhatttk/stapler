/**
 * PDF → images options (CNV-02), plus GAP-5's size controls: a longest-side
 * pixel limit, and an "Aim for a file size" mode that searches JPEG quality and
 * scale per image and reports, per page, whether the target was met.
 */
import { activeDoc, selectedPageKeys, sources } from '../../../core/store';
import { fitWithin } from '../../../core/image-target';
import { Field, NumberInput, RadioGroup, Select } from '../../components/Field';
import { formatBytes, formatBytesUp } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import { pdfToImageSettings } from '../state';
import { maxDimensionOptions, pdfToImageReport } from './pdf-to-img-state';
import { tKey, tPlural, useTranslation } from '../../../core/i18n';
import { IMAGE_TARGET_BOUNDS, targetKbInRange } from '../../../core/deep-link';

const DPI_OPTIONS = [
  { value: 72, label: tKey('72 DPI — screen') },
  { value: 150, label: tKey('150 DPI — general') },
  { value: 300, label: tKey('300 DPI — print') },
  { value: 600, label: tKey('600 DPI — archival') }
] as const;

const MIN_TARGET_KB = IMAGE_TARGET_BOUNDS.minBytes / 1000;
const MAX_TARGET_KB = IMAGE_TARGET_BOUNDS.maxBytes / 1000;

export function PdfToImagePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = pdfToImageSettings.value;
  const report = pdfToImageReport.value;
  if (!doc) return null;

  const selected = selectedPageKeys.value.size;
  const pageCount = selected > 0 ? selected : doc.pages.length;
  // IMG-7: the estimate is for the first page that will be exported, at its
  // real size — `pageSizes` already has `/Rotate` applied, and a quarter turn
  // made in Stapler swaps the sides — with the box applied to the longest
  // side, the way the export applies it.
  const first =
    (selected > 0 ? doc.pages.find(page => selectedPageKeys.value.has(page.key)) : undefined) ??
    doc.pages[0];
  const targetMode = settings.sizeMode === 'target';
  const format = targetMode ? 'jpeg' : settings.format;
  const pageSize = first
    ? sources.value[first.sourceDocId]?.pageSizes[first.sourceIndex]
    : undefined;
  const quarterTurn = first ? first.rotation % 180 !== 0 : false;
  const pointsWide = pageSize ? (quarterTurn ? pageSize.height : pageSize.width) : 595;
  const pointsHigh = pageSize ? (quarterTurn ? pageSize.width : pageSize.height) : 842;
  const { width } = fitWithin(
    (pointsWide * settings.dpi) / 72,
    (pointsHigh * settings.dpi) / 72,
    settings.maxDimension
  );
  const shownReport = report && report.docId === doc.id ? report : null;
  const missed = shownReport ? shownReport.pages.filter(page => !page.reached) : [];

  return (
    <>
      <RadioGroup<'resolution' | 'target'>
        legend={t('Output size')}
        name="imageSizeMode"
        value={settings.sizeMode}
        onChange={sizeMode => (pdfToImageSettings.value = { ...settings, sizeMode })}
        options={[
          {
            value: 'resolution',
            label: t('Choose resolution'),
            hint: t('Every page at the resolution below.')
          },
          {
            value: 'target',
            label: t('Aim for a file size'),
            hint: t(
              'JPEG only. Each image is measured and made as sharp as fits under the size you set.'
            )
          }
        ]}
      />

      {targetMode ? (
        <Field
          label={t('Size per image (KB)')}
          hint={t(
            'If a page cannot get that small, Stapler keeps the smallest version it made and tells you which page.'
          )}
        >
          {id => {
            // Stored exactly as typed (IMG-2): an out-of-range or empty value is
            // shown with an inline error and refused by the export, never
            // silently replaced by the last good one.
            const invalid = !targetKbInRange(settings.targetKb);
            const errorId = `${id}-error`;
            return (
              <>
                <NumberInput
                  id={id}
                  min={MIN_TARGET_KB}
                  max={MAX_TARGET_KB}
                  step={10}
                  value={Number.isNaN(settings.targetKb) ? '' : settings.targetKb}
                  data-image-target-kb={settings.targetKb}
                  aria-invalid={invalid ? true : undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  onInput={event => {
                    const raw = (event.target as HTMLInputElement).value;
                    const value = raw.trim() === '' ? NaN : Number(raw);
                    pdfToImageSettings.value = { ...settings, targetKb: value };
                  }}
                />
                {invalid && (
                  <p id={errorId} className={panelStyles.note} role="alert">
                    {t('Enter a size between {min} and {max}.', {
                      min: formatBytes(IMAGE_TARGET_BOUNDS.minBytes),
                      max: formatBytes(IMAGE_TARGET_BOUNDS.maxBytes)
                    })}
                  </p>
                )}
              </>
            );
          }}
        </Field>
      ) : (
        <RadioGroup<'jpeg' | 'png'>
          legend={t('Format')}
          name="imageFormat"
          value={settings.format}
          onChange={next => (pdfToImageSettings.value = { ...settings, format: next })}
          options={[
            { value: 'jpeg', label: 'JPEG', hint: t('Smaller; best for scans and photos') },
            { value: 'png', label: 'PNG', hint: t('Lossless; best for text and diagrams') }
          ]}
        />
      )}

      <Field
        label={targetMode ? t('Starting resolution') : t('Resolution')}
        hint={
          targetMode
            ? t('The sharpest the images can be. The search only ever goes down from here.')
            : undefined
        }
      >
        {id => (
          <Select
            id={id}
            value={settings.dpi}
            options={DPI_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
            onChange={dpi => (pdfToImageSettings.value = { ...settings, dpi })}
          />
        )}
      </Field>

      <Field
        label={t('Longest side at most')}
        hint={t('Pages larger than this are scaled down. Smaller pages are never enlarged.')}
      >
        {id => (
          <Select
            id={id}
            value={settings.maxDimension ?? 0}
            options={maxDimensionOptions(settings.maxDimension, t)}
            onChange={value =>
              (pdfToImageSettings.value = { ...settings, maxDimension: value > 0 ? value : null })
            }
          />
        )}
      </Field>

      <p className={panelStyles.description}>
        {tPlural('{count} pages → {format} in a ZIP.', pageCount, {
          format: format === 'jpeg' ? 'JPG' : 'PNG'
        })}
        {first &&
          (targetMode
            ? targetKbInRange(settings.targetKb)
              ? ` ${t('At most {width}px wide, each at or under {size}.', { width, size: `${settings.targetKb} KB` })}`
              : ''
            : ` ${t('About {width}px wide.', { width })}`)}
      </p>
      {settings.dpi >= 600 && !settings.maxDimension && (
        <p className={panelStyles.note}>
          {t(
            '600 DPI produces very large images. Consider exporting a page range rather than a whole long document.'
          )}
        </p>
      )}

      {shownReport && shownReport.targetBytes !== null && (
        <div
          className={panelStyles.section}
          data-image-target-report={missed.length === 0 ? 'reached' : 'missed'}
        >
          <h2 className={panelStyles.title}>{t('Last export')}</h2>
          <p className={panelStyles.description}>
            {missed.length === 0
              ? tPlural('All {count} images are at or under the target.', shownReport.pages.length)
              : tPlural(
                  '{count} images could not reach the target; each was saved at the smallest size Stapler could make.',
                  missed.length
                )}
          </p>
          <ul className={panelStyles.list}>
            {shownReport.pages.map(page => (
              <li
                className={panelStyles.listRow}
                key={page.fileName}
                data-reached={page.reached ? 'true' : 'false'}
                data-bytes={page.bytes}
              >
                <span className={panelStyles.listRowText}>
                  {t('Page {page}: {size}, {width}×{height} px', {
                    page: page.pageIndex + 1,
                    // A miss is rounded up, so it never reads as the target (IMG-3).
                    size: page.reached ? formatBytes(page.bytes) : formatBytesUp(page.bytes),
                    width: page.width,
                    height: page.height
                  })}
                </span>
                <span>{page.reached ? t('Fits') : t('Over target')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
