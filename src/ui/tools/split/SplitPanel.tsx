/**
 * Split and extract options (OPS-03, plus OPS-12's bookmark mode).
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { splitBoundaries } from '../../../core/operations';
import { Field, NumberInput, RadioGroup, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { splitSettings, type SplitMode } from '../state';
import { outlineDocId, outlineLoading, outlineTree, topLevelSlices } from '../outline/state';
import { useDocumentOutline } from '../outline/useOutline';
import { useTranslation } from '../../../core/i18n';
import { hasDirectoryPicker } from '../../../platform/fsa';

export function SplitPanel() {
  const t = useTranslation();
  // OPS-12 needs the same outline the bookmark editor loads, so read it here too.
  useDocumentOutline();
  const doc = activeDoc.value;
  const settings = splitSettings.value;
  if (!doc) return null;

  const update = (patch: Partial<typeof settings>) => {
    splitSettings.value = { ...settings, ...patch };
  };

  const bookmarks = topLevelSlices(
    outlineDocId.value === doc.id ? outlineTree.value : [],
    doc.pages.map(page => page.key)
  );

  const boundaries =
    settings.mode === 'extract'
      ? []
      : splitBoundaries(settings.mode, doc.pages.length, {
          every: settings.everyN,
          custom: settings.customBoundaries,
          bookmarkStarts: bookmarks.map(bookmark => bookmark.pageIndex)
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
          { value: 'custom', label: 'Split at chosen pages' },
          {
            value: 'bookmarks',
            label: 'Split at bookmarks',
            hint: 'One file per top-level bookmark, named after it'
          }
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

      {settings.mode === 'bookmarks' && (
        <p className={panelStyles.description}>
          {outlineLoading.value
            ? t('Reading bookmarks…')
            : bookmarks.length === 0
              ? t('This document has no top-level bookmarks to split at.')
              : `${bookmarks.length} top-level bookmark(s): ${bookmarks
                  .map(bookmark => bookmark.title)
                  .join(', ')}`}
        </p>
      )}

      <p className={panelStyles.description}>
        {settings.mode === 'extract'
          ? `${selectedPageKeys.value.size} page(s) selected.`
          : `Produces ${boundaries.length + 1} file(s).` +
            (boundaries.length > 0 && settings.outputFormat === 'zip'
              ? ' Multiple files are delivered as a ZIP.'
              : '')}
      </p>

      {settings.mode !== 'extract' && hasDirectoryPicker() && (
        <RadioGroup<'zip' | 'directory'>
          legend={t('Output Format')}
          name="outputFormat"
          value={settings.outputFormat}
          onChange={format => update({ outputFormat: format })}
          options={[
            { value: 'zip', label: 'ZIP Archive' },
            { value: 'directory', label: 'Output Folder', hint: 'Save directly to a folder' }
          ]}
        />
      )}
    </>
  );
}
