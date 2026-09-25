/**
 * PDF → images options (CNV-02).
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { Field, RadioGroup, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { pdfToImageSettings } from '../state';
import { tKey, tPlural, useTranslation } from '../../../core/i18n';

const DPI_OPTIONS = [
  { value: 72, label: tKey('72 DPI — screen') },
  { value: 150, label: tKey('150 DPI — general') },
  { value: 300, label: tKey('300 DPI — print') },
  { value: 600, label: tKey('600 DPI — archival') }
] as const;

export function PdfToImagePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = pdfToImageSettings.value;
  if (!doc) return null;

  const selected = selectedPageKeys.value.size;
  const pageCount = selected > 0 ? selected : doc.pages.length;
  const first = doc.pages[0];

  return (
    <>
      <RadioGroup<'jpeg' | 'png'>
        legend={t('Format')}
        name="imageFormat"
        value={settings.format}
        onChange={format => (pdfToImageSettings.value = { ...settings, format })}
        options={[
          { value: 'jpeg', label: 'JPEG', hint: t('Smaller; best for scans and photos') },
          { value: 'png', label: 'PNG', hint: t('Lossless; best for text and diagrams') }
        ]}
      />

      <Field label={t('Resolution')}>
        {id => (
          <Select
            id={id}
            value={settings.dpi}
            options={DPI_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
            onChange={dpi => (pdfToImageSettings.value = { ...settings, dpi })}
          />
        )}
      </Field>

      <p className={panelStyles.description}>
        {tPlural('{count} pages → {format} in a ZIP.', pageCount, {
          format: settings.format === 'jpeg' ? 'JPG' : 'PNG'
        })}
        {first &&
          ` ${t('About {width}px wide.', { width: Math.round((595 * settings.dpi) / 72) })}`}
      </p>
      {settings.dpi >= 600 && (
        <p className={panelStyles.note}>
          {t(
            '600 DPI produces very large images. Consider exporting a page range rather than a whole long document.'
          )}
        </p>
      )}
    </>
  );
}
