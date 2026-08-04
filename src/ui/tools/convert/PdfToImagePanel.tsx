/**
 * PDF → images options (CNV-02).
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { Field, RadioGroup, Select } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { pdfToImageSettings } from '../state';

const DPI_OPTIONS = [
  { value: 72, label: '72 DPI — screen' },
  { value: 150, label: '150 DPI — general' },
  { value: 300, label: '300 DPI — print' },
  { value: 600, label: '600 DPI — archival' }
] as const;

export function PdfToImagePanel() {
  const doc = activeDoc.value;
  const settings = pdfToImageSettings.value;
  if (!doc) return null;

  const selected = selectedPageKeys.value.size;
  const pageCount = selected > 0 ? selected : doc.pages.length;
  const first = doc.pages[0];

  return (
    <>
      <RadioGroup<'jpeg' | 'png'>
        legend="Format"
        name="imageFormat"
        value={settings.format}
        onChange={format => (pdfToImageSettings.value = { ...settings, format })}
        options={[
          { value: 'jpeg', label: 'JPEG', hint: 'Smaller; best for scans and photos' },
          { value: 'png', label: 'PNG', hint: 'Lossless; best for text and diagrams' }
        ]}
      />

      <Field label="Resolution">
        {id => (
          <Select
            id={id}
            value={settings.dpi}
            options={DPI_OPTIONS}
            onChange={dpi => (pdfToImageSettings.value = { ...settings, dpi })}
          />
        )}
      </Field>

      <p className={panelStyles.description}>
        {pageCount} page(s) → {settings.format === 'jpeg' ? 'JPG' : 'PNG'} in a ZIP.
        {first && ` About ${Math.round((595 * settings.dpi) / 72)}px wide.`}
      </p>
      {settings.dpi >= 600 && (
        <p className={panelStyles.note}>
          600 DPI produces very large images. Consider exporting a page range rather than a whole
          long document.
        </p>
      )}
    </>
  );
}
