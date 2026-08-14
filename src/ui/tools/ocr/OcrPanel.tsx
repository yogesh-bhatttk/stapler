/**
 * OCR-01 — the OCR options panel.
 *
 * Deliberately small. The one decision worth exposing is *which pages*, because
 * recognition is the slowest operation in the app and running it on pages that
 * already carry text costs minutes and gains nothing. Language is a select rather
 * than a hard-coded label so OCR-02 can extend `OCR_LANGUAGES` without touching
 * this file, even though exactly one entry ships today.
 *
 * Every control comes from `components/Field`, so the focus ring, the label
 * association, the 32px target, and both themes are inherited rather than
 * reimplemented.
 */
import { Checkbox, Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { selectedPageKeys } from '../../../core/store';
import { OCR_LANGUAGES } from '../../../core/ocr/model';
import { useTranslation } from '../../../core/i18n';
import { ocrReport, ocrSettings } from './state';

export function OcrPanel() {
  const t = useTranslation();
  const settings = ocrSettings.value;
  const report = ocrReport.value;
  const selected = selectedPageKeys.value.size;

  const update = (patch: Partial<typeof settings>) => {
    ocrSettings.value = { ...settings, ...patch };
  };

  return (
    <>
      <Field label={t('Language')}>
        {id => (
          <Select
            id={id}
            value={settings.lang}
            options={OCR_LANGUAGES.map(language => ({
              value: language.code,
              label: language.label
            }))}
            onChange={lang => update({ lang })}
          />
        )}
      </Field>

      <Checkbox
        label={t('Only the pages selected in the grid')}
        checked={settings.selectedPagesOnly}
        onChange={selectedPagesOnly => update({ selectedPagesOnly })}
      />

      {settings.selectedPagesOnly && selected === 0 && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('No pages are selected. Tick pages in the grid, or turn this option off.')}
        </p>
      )}

      <p className={panelStyles.description}>
        {t(
          'OCR reads the text in a scanned page and writes it back as an invisible layer over the ' +
            'image. The page looks exactly the same; the text becomes selectable and searchable.'
        )}
      </p>

      <p className={panelStyles.description}>
        {t(
          'The first run downloads a language model — Stapler asks before it does, and says what ' +
            'and from where. After that, OCR needs no network at all.'
        )}
      </p>

      {report && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {report.wordsAdded === 0
            ? t('The last run found no text on those pages.')
            : `${report.wordsAdded} words added across ${report.pages} page${
                report.pages === 1 ? '' : 's'
              }.${
                report.wordsSkipped > 0
                  ? ` ${report.wordsSkipped} could not be encoded and were left out.`
                  : ''
              }`}
        </p>
      )}
    </>
  );
}
