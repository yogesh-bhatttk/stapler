import { translate } from '../../../core/i18n';
import { Button } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import {
  inputDirHandle,
  outputDirHandle,
  savedRecipes,
  activeRecipeId,
  batchProgress,
  outputPattern,
  outputFormat,
  outputZipHandle,
  Recipe,
  loadRecipes,
  addRecipe
} from './state';
import { compressSettings } from '../compress/state';
import type { CompressSettings } from '../compress/state';
import { watermarkSettings, headerFooterSettings } from '../watermark/state';
import type { WatermarkSettings, HeaderFooterSettings } from '../watermark/state';
import { nupSettings } from '../nup/state';
import type { NUpSettings } from '../nup/state';
import { normalizeSettings } from '../normalize/state';
import type { NormalizeSettings } from '../normalize/state';
import { runBatch } from './runner';
import { useTranslation } from '../../../core/i18n';

import { useRef, useEffect } from 'preact/hooks';

import {
  hasDirectoryPicker,
  showDirectoryPicker,
  isAbort,
  showSaveFilePicker
} from '../../../platform/fsa';
import { notify } from '../../../core/notify';

export function BatchPanel() {
  const t = useTranslation();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadRecipes().catch(e => console.error('Failed to load recipes', e));
  }, []);

  const reportPickerFailure = (scope: string, error: unknown) => {
    if (isAbort(error)) return;

    const detail =
      error instanceof DOMException
        ? `${error.name}${error.message ? `: ${error.message}` : ''}`
        : error instanceof Error
          ? error.message
          : 'Please try selecting the folder again.';

    notify('warning', scope, { detail });
  };

  const handleSelectInput = async () => {
    if (!hasDirectoryPicker()) {
      notify('warning', translate('Directory selection unavailable'), {
        detail:
          'Folder processing requires a browser with File System Access support (Chrome or Edge).'
      });
      return;
    }
    try {
      const dir = await showDirectoryPicker({ mode: 'read' });
      inputDirHandle.value = dir;
    } catch (e) {
      reportPickerFailure('Input folder selection failed', e);
    }
  };

  const handleSelectOutput = async () => {
    if (!hasDirectoryPicker()) {
      notify('warning', translate('Directory selection unavailable'), {
        detail:
          'Folder processing requires a browser with File System Access support (Chrome or Edge).'
      });
      return;
    }
    try {
      const dir = await showDirectoryPicker({ mode: 'readwrite' });
      outputFormat.value = 'directory';
      outputDirHandle.value = dir;
    } catch (e) {
      reportPickerFailure('Output folder selection failed', e);
    }
  };

  const handleSelectZipOutput = async () => {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: 'batch-output.zip',
        types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
      });
      outputFormat.value = 'zip';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outputZipHandle.value = handle as any;
    } catch (e) {
      reportPickerFailure('Output ZIP selection failed', e);
    }
  };

  /**
   * A recipe is a *snapshot*, not a pointer at whatever some other tool's panel
   * happens to hold later. Two things were wrong before:
   *
   *  • untouched settings were stored as `null`, and the runner's `?? live.value`
   *    fell straight through them to the signal's current value — so replaying a
   *    recipe applied whatever the N-up or Normalize panel had open at run time;
   *  • the stored objects were shallow copies sharing nested references with the
   *    live signals, so editing a nested field afterwards edited the saved recipe.
   *
   * `structuredClone` fixes the second; recording `undefined` for a setting that
   * genuinely has no value fixes the first — the runner then knows the recipe says
   * "not configured" rather than "ask the signal".
   */
  const snapshot = <T,>(value: T | null | undefined): T | undefined =>
    value == null ? undefined : (structuredClone(value) as T);

  const handleSaveRecipe = async () => {
    const name = window.prompt('Recipe name:');
    if (!name) return;

    // Ask user for tools and order
    const defaultTools = ['watermark', 'normalize', 'nup', 'compress'];
    const toolsInput = window.prompt(
      'Enter tools for this recipe in order (comma separated):\nAvailable: watermark, normalize, nup, compress',
      defaultTools.join(', ')
    );
    if (!toolsInput) return;
    const tools = toolsInput
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => defaultTools.includes(t)) as Recipe['tools'];

    const newRecipe: Recipe = {
      id: crypto.randomUUID(),
      name,
      tools,
      settings: {
        compress: snapshot<CompressSettings>(compressSettings.value),
        watermark: snapshot<WatermarkSettings>(watermarkSettings.value),
        headerFooter: snapshot<HeaderFooterSettings>(headerFooterSettings.value),
        nup: snapshot<NUpSettings>(nupSettings.value),
        normalize: snapshot<NormalizeSettings>(normalizeSettings.value)
      }
    };
    await addRecipe(newRecipe);
    activeRecipeId.value = newRecipe.id;
  };

  const handleExportRecipes = () => {
    const blob = new Blob([JSON.stringify(savedRecipes.value, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stapler-recipes.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportRecipes = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const recipes = JSON.parse(text) as Recipe[];
        for (const r of recipes) {
          if (r.id && r.name && Array.isArray(r.tools) && typeof r.settings === 'object') {
            await addRecipe(r);
          }
        }
        notify('success', translate('Recipes imported successfully'));
      } catch (err) {
        notify('danger', translate('Failed to import recipes'), { detail: String(err) });
      }
    };
    input.click();
  };

  const handleRun = async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    await runBatch(controller.signal);
    abortControllerRef.current = null;
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  return (
    <>
      <div className={panelStyles.section}>
        <Button onClick={handleSelectInput} variant="secondary">
          {inputDirHandle.value ? `Input: ${inputDirHandle.value.name}` : 'Select Input Folder'}
        </Button>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button onClick={handleSelectOutput} variant="secondary">
            {outputFormat.value === 'directory' && outputDirHandle.value
              ? `Output: ${outputDirHandle.value.name}/`
              : 'Select Output Folder'}
          </Button>
          <Button onClick={handleSelectZipOutput} variant="secondary">
            {outputFormat.value === 'zip' && outputZipHandle.value
              ? `Output: ${outputZipHandle.value.name}`
              : 'Select Output ZIP'}
          </Button>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Field label={t('Recipe')}>
          {id => (
            <Select
              id={id}
              value={activeRecipeId.value || ''}
              onChange={val => (activeRecipeId.value = val || null)}
              options={[
                { value: '', label: 'None (Use current settings)' },
                ...savedRecipes.value.map(r => ({ value: r.id, label: r.name }))
              ]}
            />
          )}
        </Field>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button onClick={handleSaveRecipe} variant="secondary">
            {t('Save current as recipe')}
          </Button>
          <Button onClick={handleExportRecipes} variant="secondary">
            {t('Export')}
          </Button>
          <Button onClick={handleImportRecipes} variant="secondary">
            {t('Import')}
          </Button>
        </div>
      </div>

      <div className={panelStyles.section}>
        <Field label={t('Output filename pattern')}>
          {id => (
            <input
              id={id}
              type="text"
              value={outputPattern.value}
              onInput={e => (outputPattern.value = (e.target as HTMLInputElement).value)}
              placeholder="{basename}"
              style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85em' }}
            />
          )}
        </Field>
        <p style={{ fontSize: '0.75em', opacity: 0.7, margin: '4px 0 0' }}>
          Tokens: <code>{'{basename}'}</code>, <code>{'{index}'}</code>, <code>{'{date}'}</code>
        </p>
      </div>

      {batchProgress.value.isProcessing && (
        <div
          className={panelStyles.section}
          role="progressbar"
          aria-valuenow={batchProgress.value.completed}
          aria-valuemax={batchProgress.value.total}
        >
          <p>
            {t('Processing:')} {batchProgress.value.currentFile}
          </p>
          <p>
            {batchProgress.value.completed} / {batchProgress.value.total} {t('completed')}
          </p>
          <p>
            {batchProgress.value.failed} {t('failed')}
          </p>
        </div>
      )}

      {batchProgress.value.notes.length > 0 && (
        <div className={panelStyles.section}>
          <p>
            {batchProgress.value.notes.filter(n => n.kind === 'kept-original').length}{' '}
            {t('written unchanged')}
            {batchProgress.value.notes.some(n => n.kind === 'failed') && (
              <>
                {' '}
                | {batchProgress.value.notes.filter(n => n.kind === 'failed').length} {t('failed')}
              </>
            )}
          </p>
          <ul style={{ margin: 0, paddingInlineStart: '20px', fontSize: '0.85em' }}>
            {batchProgress.value.notes.map(note => (
              <li
                key={`${note.file}-${note.detail}`}
                style={note.kind === 'failed' ? { color: 'var(--danger)' } : {}}
              >
                {note.file} — {note.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={panelStyles.section}>
        <Button
          onClick={handleRun}
          disabled={
            !inputDirHandle.value ||
            (outputFormat.value === 'directory'
              ? !outputDirHandle.value
              : !outputZipHandle.value) ||
            batchProgress.value.isProcessing
          }
        >
          {t('Run Batch')}
        </Button>
        {batchProgress.value.isProcessing && (
          <Button onClick={handleCancel} variant="secondary">
            {t('Cancel')}
          </Button>
        )}
      </div>
    </>
  );
}
