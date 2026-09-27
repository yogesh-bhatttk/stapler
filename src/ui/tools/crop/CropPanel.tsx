import { RotateCcw, Scissors } from 'lucide-preact';
import { activeDoc, activePageIndex } from '../../../core/store';
import { commit } from '../../../core/history';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { cropBoxes, cropSettings, pagesForScope, type CropScope } from './state';
import { useJob } from '../../useJob';
import { autoTrimDocument } from '../../../core/operations';
import { tKey, translate, useTranslation } from '../../../core/i18n';

const SCOPE_OPTIONS: { value: CropScope; label: string }[] = [
  { value: 'current', label: tKey('Current page only') },
  { value: 'all', label: tKey('All pages') },
  { value: 'odd', label: tKey('Odd pages') },
  { value: 'even', label: tKey('Even pages') }
];

const SCOPE_LABEL: Record<CropScope, string> = {
  current: tKey('current page'),
  all: tKey('all pages'),
  odd: tKey('odd pages'),
  even: tKey('even pages')
};

export function CropPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = cropSettings.value;
  const { run } = useJob();

  if (!doc) return null;

  const handleAutoTrim = () => {
    run({ label: translate('Auto-trimming pages'), scope: 'crop.autotrim' }, async job => {
      await autoTrimDocument(doc, settings.scope, job);
    });
  };

  const handleReset = () => {
    const targets = pagesForScope(doc.pages, settings.scope, activePageIndex.value);
    if (targets.length === 0) return;
    commit();
    const next = { ...cropBoxes.value };
    for (const page of targets) delete next[page.key];
    cropBoxes.value = next;
  };

  return (
    <>
      <Field label={t('Apply crop to')}>
        {id => (
          <Select
            id={id}
            value={settings.scope}
            options={SCOPE_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
            onChange={val => (cropSettings.value = { ...settings, scope: val })}
          />
        )}
      </Field>

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Manual crop')}</h2>
        <p className={panelStyles.description}>
          {t(
            'Drag on the page to draw a crop box, drag its handles to resize, or drag inside it to move it. The box applies to {scope}.',
            { scope: t(SCOPE_LABEL[settings.scope]) }
          )}
        </p>
        <Button variant="secondary" icon={RotateCcw} onClick={handleReset}>
          {t('Reset crop on {scope}', { scope: t(SCOPE_LABEL[settings.scope]) })}
        </Button>
      </div>

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Auto-trim')}</h2>
        <p className={panelStyles.description}>
          {t(
            'Automatically detect ink on the page(s) and shrink the crop box to fit the content, removing white margins.'
          )}
        </p>
        <Button variant="secondary" icon={Scissors} onClick={handleAutoTrim}>
          {t('Auto-trim {scope}', { scope: t(SCOPE_LABEL[settings.scope]) })}
        </Button>
      </div>
    </>
  );
}
