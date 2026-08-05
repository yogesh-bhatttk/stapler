import { Scissors } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { cropSettings } from './state';
import { useJob } from '../../useJob';
import { autoTrimDocument } from '../../../core/operations';

const SCOPE_OPTIONS = [
  { value: 'current', label: 'Current page only' },
  { value: 'all', label: 'All pages' }
] as const;

export function CropPanel() {
  const doc = activeDoc.value;
  const settings = cropSettings.value;
  const { run } = useJob();

  if (!doc) return null;

  const handleAutoTrim = () => {
    run({ label: 'Auto-trimming pages', scope: 'crop.autotrim' }, async job => {
      // Logic for auto trim
      await autoTrimDocument(doc, settings.applyToAll, job);
    });
  };

  return (
    <>
      <Field label="Apply manual crop to">
        {id => (
          <Select
            id={id}
            value={settings.applyToAll ? 'all' : 'current'}
            options={SCOPE_OPTIONS}
            onChange={val => (cropSettings.value = { ...settings, applyToAll: val === 'all' })}
          />
        )}
      </Field>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>Auto-trim</h3>
        <p className={panelStyles.description}>
          Automatically detect ink on the page(s) and shrink the crop box to fit the content,
          removing white margins.
        </p>
        <Button variant="secondary" icon={Scissors} onClick={handleAutoTrim}>
          Auto-trim {settings.applyToAll ? 'all pages' : 'current page'}
        </Button>
      </div>
    </>
  );
}
