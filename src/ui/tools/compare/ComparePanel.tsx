import { useState } from 'preact/hooks';
import { compareSettings } from './state';
import { Button } from '../../components/Button';
import { RadioGroup, Slider, Field } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { platform } from '../../../platform/current';
import { importFiles } from '../../../core/import';
import { logEvent, fromUnknown } from '../../../core/errors';
import { useTranslation } from '../../../core/i18n';

export function ComparePanel() {
  const t = useTranslation();
  const settings = compareSettings.value;
  const [loading, setLoading] = useState(false);

  const handleOpenCompareFile = async () => {
    try {
      setLoading(true);
      const files = await platform.openFiles({ accept: { 'application/pdf': ['.pdf'] } });
      if (files.length === 0) return;
      const fileObjects = await Promise.all(files.map(f => f.getFile()));
      const { imported, failures } = await importFiles(fileObjects);
      if (imported.length > 0) {
        compareSettings.value = { ...settings, compareSourceId: imported[0].source.id };
      }
      if (failures.length > 0) {
        logEvent('error', 'compare', failures[0].message);
      }
    } catch (err: unknown) {
      logEvent('error', 'compare', fromUnknown(err).message);
    } finally {
      setLoading(false);
    }
  };

  const update = (patch: Partial<typeof settings>) => {
    compareSettings.value = { ...settings, ...patch };
  };

  return (
    <>
      <div className={panelStyles.section}>
        <Button onClick={handleOpenCompareFile} disabled={loading}>
          {settings.compareSourceId ? 'Change comparison file...' : 'Open file to compare...'}
        </Button>
      </div>

      <RadioGroup
        legend={t('Compare Mode')}
        name="diffMode"
        value={settings.diffMode}
        onChange={mode => update({ diffMode: mode as 'visual' | 'text' })}
        options={[
          { value: 'visual', label: 'Visual Pixel Diff', hint: 'Highlights modified pixels' },
          { value: 'text', label: 'Text Diff', hint: 'Highlights added and removed text' }
        ]}
      />

      {settings.diffMode === 'visual' && (
        <Field label={t('Sensitivity')} value={`${settings.sensitivity}%`}>
          {id => (
            <Slider
              id={id}
              min={0}
              max={100}
              value={settings.sensitivity}
              onChange={v => update({ sensitivity: v })}
            />
          )}
        </Field>
      )}

      {settings.diffMode === 'text' && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('Text diff shows structural text changes. Additions are green, deletions are red.')}
        </p>
      )}
    </>
  );
}
