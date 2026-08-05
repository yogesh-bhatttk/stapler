/**
 * Split and extract options (OPS-03). All four modes the ticket specifies.
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { splitBoundaries } from '../../../core/operations';
import { Field, NumberInput, RadioGroup, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { splitSettings, type SplitMode } from '../state';
import { useTranslation } from '../../../core/i18n';

export function SplitPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = splitSettings.value;
  if (!doc) return null;

  const update = (patch: Partial<typeof settings>) => {
    splitSettings.value = { ...settings, ...patch };
  };

  const boundaries =
    settings.mode === 'extract'
      ? []
      : splitBoundaries(settings.mode, doc.pages.length, {
          every: settings.everyN,
          custom: settings.customBoundaries
        });

  return (
    <>
      <RadioGroup<SplitMode>
        legend={t('Mode')}
        name="splitMode"
        value={settings.mode}
        onChange={mode => update({ mode })}
        options={[
          { value: 'extract', label: 'Extract selected pages', hint: 'One new file' },
          { value: 'individual', label: 'Split into single pages' },
          { value: 'every_n', label: 'Split every N pages' },
          { value: 'custom', label: 'Split at chosen pages' }
        ]}
      />

      {settings.mode === 'every_n' && (
        <Field label={t('Pages per file')}>
          {id => (
            <NumberInput
              id={id}
              min={1}
              max={Math.max(1, doc.pages.length)}
              value={settings.everyN}
              onInput={event =>
                update({
                  everyN: Math.max(1, Number((event.target as HTMLInputElement).value) || 1)
                })
              }
            />
          )}
        </Field>
      )}

      {settings.mode === 'custom' && (
        <Field
          label={t('Split after page')}
          hint={`Comma-separated page numbers between 1 and ${doc.pages.length - 1}.`}
        >
          {id => (
            <TextInput
              id={id}
              placeholder={t('5, 10, 15')}
              value={settings.customBoundaries}
              onInput={event =>
                update({ customBoundaries: (event.target as HTMLInputElement).value })
              }
            />
          )}
        </Field>
      )}

      <p className={panelStyles.description}>
        {settings.mode === 'extract'
          ? `${selectedPageKeys.value.size} page(s) selected.`
          : `Produces ${boundaries.length + 1} file(s).` +
            (boundaries.length > 0 ? ' Multiple files are delivered as a ZIP.' : '')}
      </p>
    </>
  );
}
