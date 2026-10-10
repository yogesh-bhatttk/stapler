/**
 * OCR-01 & OCR-02 — the OCR options panel.
 */
import { useEffect, useState } from 'preact/hooks';
import { Trash2 } from 'lucide-preact';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { selectedPageKeys } from '../../../core/store';
import { OCR_LANGUAGES } from '../../../core/ocr/model';
import { listStoredOcrModels, removeAllOcrModels } from '../../../core/ocr/modelState';
import { notify, notifyError } from '../../../core/notify';
import { tPlural, translate, useTranslation } from '../../../core/i18n';
import { ocrReport, ocrSettings } from './state';
import { FolderSearchPanel } from './FolderSearchPanel';

export function OcrPanel() {
  const t = useTranslation();
  const settings = ocrSettings.value;
  const report = ocrReport.value;
  const selected = selectedPageKeys.value.size;
  // Audit 2026-09-25 CNV-8 — the only way to get rid of a stored language
  // model used to be clearing all site data.
  const [storedModels, setStoredModels] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let live = true;
    void listStoredOcrModels()
      .then(codes => {
        if (live) setStoredModels(codes);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Re-checked after each run, which is when a model can have been added.
  }, [report]);

  const removeModels = async () => {
    setRemoving(true);
    try {
      await removeAllOcrModels();
      setStoredModels([]);
      notify('success', translate('Stored OCR language models removed.'), {
        detail: translate('The next OCR run will ask before downloading a model again.')
      });
    } catch (err) {
      notifyError('Remove OCR models', err);
    } finally {
      setRemoving(false);
    }
  };

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
              label: t(language.label)
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

      <Checkbox
        label={t('Also OCR pages that already have text')}
        checked={settings.includePagesWithText}
        onChange={includePagesWithText => update({ includePagesWithText })}
      />

      {settings.selectedPagesOnly && selected === 0 && (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
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

      {storedModels.length > 0 && (
        <Button
          variant="secondary"
          size="compact"
          icon={Trash2}
          disabled={removing}
          onClick={() => void removeModels()}
        >
          {t('Remove stored language models ({langs})', { langs: storedModels.join(', ') })}
        </Button>
      )}

      {report && (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
          {report.wordsAdded === 0 && report.pagesWithText > 0
            ? tPlural('{count} pages already had text and were left as-is.', report.pagesWithText)
            : report.wordsAdded === 0
              ? t('The last run found no text on those pages.')
              : [
                  tPlural('{count} words added across {pages}.', report.wordsAdded, {
                    pages: tPlural('{count} pages', report.pages)
                  }),
                  report.wordsSkipped > 0 &&
                    tPlural('{count} could not be encoded and were left out.', report.wordsSkipped),
                  report.pagesReplaced > 0 &&
                    tPlural(
                      'Replaced an existing, broken text layer on {count} pages.',
                      report.pagesReplaced
                    ),
                  report.pagesSkipped > 0 &&
                    tPlural(
                      '{count} pages could not be scanned and were left as-is.',
                      report.pagesSkipped
                    ),
                  report.pagesWithText > 0 &&
                    tPlural(
                      '{count} pages already had text and were left as-is.',
                      report.pagesWithText
                    )
                ]
                  .filter(Boolean)
                  .join(' ')}
        </p>
      )}

      <hr className={panelStyles.divider} />

      <FolderSearchPanel />
    </>
  );
}
