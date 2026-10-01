/**
 * Split and extract options (OPS-03, plus OPS-12's bookmark mode).
 */
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { splitBoundaries, splitPointsError } from '../../../core/operations';
import { Field, NumberInput, RadioGroup, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { splitSettings, type SplitMode } from '../state';
import { outlineDocId, outlineLoading, outlineTree, topLevelSlices } from '../outline/state';
import { useDocumentOutline } from '../outline/useOutline';
import { tPlural, useTranslation } from '../../../core/i18n';
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
    settings.mode === 'extract' || settings.mode === 'size'
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
          { value: 'extract', label: t('Extract selected pages'), hint: t('One new file') },
          { value: 'individual', label: t('Split into single pages') },
          { value: 'every_n', label: t('Split every N pages') },
          { value: 'custom', label: t('Split at chosen pages') },
          {
            value: 'bookmarks',
            label: t('Split at bookmarks'),
            hint: t('One file per top-level bookmark, named after it')
          },
          {
            value: 'size',
            label: t('Split by target file size'),
            hint: t('Consecutive pages per file, each at or under a size limit')
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
          hint={t('Comma-separated page numbers between 1 and {max}.', {
            max: doc.pages.length - 1
          })}
        >
          {id => {
            // X-8: name tokens that are not plain page numbers instead of
            // silently cutting somewhere the user did not ask for.
            const error = splitPointsError(settings.customBoundaries);
            const errorId = `${id}-error`;
            return (
              <>
                <TextInput
                  id={id}
                  placeholder={t('5, 10, 15')}
                  value={settings.customBoundaries}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onInput={event =>
                    update({ customBoundaries: (event.target as HTMLInputElement).value })
                  }
                />
                {error && (
                  <p id={errorId} className={panelStyles.note} role="alert">
                    {error}
                  </p>
                )}
              </>
            );
          }}
        </Field>
      )}

      {settings.mode === 'size' && (
        <Field label={t('Target size per file (KB)')}>
          {id => (
            <NumberInput
              id={id}
              min={1}
              value={settings.targetSizeKb}
              onInput={event =>
                update({
                  targetSizeKb: Math.max(1, Number((event.target as HTMLInputElement).value) || 1)
                })
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
              : tPlural('{count} top-level bookmarks: {titles}', bookmarks.length, {
                  titles: bookmarks.map(bookmark => bookmark.title).join(', ')
                })}
        </p>
      )}

      <p className={panelStyles.description}>
        {settings.mode === 'extract'
          ? tPlural('{count} pages selected.', selectedPageKeys.value.size)
          : settings.mode === 'size'
            ? t(
                'File count is determined when you run the split, from each page’s actual composed size.'
              )
            : tPlural('Produces {count} files.', boundaries.length + 1) +
              (boundaries.length > 0 && settings.outputFormat === 'zip'
                ? ' ' + t('Multiple files are delivered as a ZIP.')
                : '')}
      </p>

      {settings.mode !== 'extract' && hasDirectoryPicker() && (
        <RadioGroup<'zip' | 'directory'>
          legend={t('Output Format')}
          name="outputFormat"
          value={settings.outputFormat}
          onChange={format => update({ outputFormat: format })}
          options={[
            { value: 'zip', label: t('ZIP Archive') },
            { value: 'directory', label: t('Output Folder'), hint: t('Save directly to a folder') }
          ]}
        />
      )}
    </>
  );
}
