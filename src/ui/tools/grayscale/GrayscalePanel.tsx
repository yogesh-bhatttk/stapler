/**
 * GAP-6 — Grayscale / black-and-white options and the last run's report.
 *
 * The report is the point of the panel: which pages kept their text and
 * vectors, which had to be rendered as pictures (and why), which images could
 * not be decoded, and what happened to the file size. Nothing is summarised as
 * "done" that was not measured on the output.
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { tKey, tPlural, useTranslation } from '../../../core/i18n';
import { Field, RadioGroup, Select } from '../../components/Field';
import { formatBytes } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import { grayscaleReport, grayscaleSettings, type GrayscaleToolSettings } from './state';

const MODES = [
  {
    value: 'gray',
    label: tKey('Shades of grey'),
    hint: tKey('Every colour becomes the grey of the same brightness.')
  },
  {
    value: 'bw',
    label: tKey('Black and white'),
    hint: tKey('For scans: pure black on white, usually the smallest file.')
  }
] as const;

const DPI_OPTIONS = [150, 200, 300] as const;

export function GrayscalePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = grayscaleSettings.value;
  const report = grayscaleReport.value;
  const selected = selectedPageKeys.value.size;
  if (!doc) return null;

  const update = (patch: Partial<GrayscaleToolSettings>) => {
    grayscaleSettings.value = { ...grayscaleSettings.value, ...patch };
  };

  const vectorPages = report?.pages.filter(p => p.route === 'vector') ?? [];
  const rasterPages = report?.pages.filter(p => p.route === 'raster') ?? [];
  const failedPages = report?.pages.filter(p => p.route === 'failed') ?? [];
  const undecodable = report?.undecodable.reduce((sum, u) => sum + u.count, 0) ?? 0;

  return (
    <>
      <div className={panelStyles.section}>
        <RadioGroup
          legend={t('Convert to')}
          name="grayscale-mode"
          value={settings.mode}
          options={MODES.map(m => ({ value: m.value, label: t(m.label), hint: t(m.hint) }))}
          onChange={mode => update({ mode })}
        />
      </div>

      <div className={panelStyles.section}>
        <RadioGroup
          legend={t('Pages')}
          name="grayscale-scope"
          value={settings.scope}
          options={[
            { value: 'all', label: tPlural('All {count} pages', doc.pages.length) },
            {
              value: 'selected',
              label:
                selected > 0
                  ? tPlural('Only the {count} selected pages', selected)
                  : t('Only the pages selected in the grid')
            }
          ]}
          onChange={scope => update({ scope })}
        />
      </div>

      <div className={panelStyles.section}>
        <Field
          label={t('Resolution for pages that must be rendered')}
          hint={t(
            'Used only where a page contains something that cannot be converted directly, such as an inline image. Those pages lose selectable text, and the report names them.'
          )}
        >
          {id => (
            <Select
              id={id}
              value={settings.rasterDpi}
              options={DPI_OPTIONS.map(dpi => ({ value: dpi, label: t('{dpi} DPI', { dpi }) }))}
              onChange={rasterDpi => update({ rasterDpi })}
            />
          )}
        </Field>
      </div>

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t(
          'Text, lines and shapes are rewritten in grey and stay sharp and selectable. Photos are converted to grey images. Annotations and form fields keep working.'
        )}
      </p>

      {report && (
        <>
          <hr className={panelStyles.divider} />
          <div className={panelStyles.section} aria-live="polite">
            <h2 className={panelStyles.title}>{t('Last conversion')}</h2>
            <ul className={panelStyles.proseList}>
              {vectorPages.length > 0 && (
                <li>
                  {tPlural(
                    '{count} pages converted directly — text and vectors kept.',
                    vectorPages.length
                  )}
                </li>
              )}
              {rasterPages.length > 0 && (
                <li>
                  {tPlural(
                    '{count} pages were rendered as images, so their text is no longer selectable:',
                    rasterPages.length
                  )}
                  <ul className={panelStyles.proseList}>
                    {rasterPages.map(page => (
                      <li key={page.pageIndex}>
                        {t('Page {page}: {reason}', {
                          page: page.pageIndex + 1,
                          reason: page.reasons.join('; ') || t('could not be converted directly')
                        })}
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              {failedPages.length > 0 && (
                <li>
                  {tPlural('{count} pages were left unchanged:', failedPages.length)}{' '}
                  {failedPages.map(p => p.pageIndex + 1).join(', ')}
                </li>
              )}
              {undecodable > 0 && (
                <li>
                  {tPlural(
                    '{count} images use an encoding (JPEG 2000 or JBIG2) that cannot be decoded here, and were left as they are.',
                    undecodable
                  )}
                </li>
              )}
              <li>
                {t('File size: {before} → {after}', {
                  before: formatBytes(report.originalBytes),
                  after: formatBytes(report.resultBytes)
                })}
              </li>
            </ul>
          </div>
        </>
      )}
    </>
  );
}
