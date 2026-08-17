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
  Recipe
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

import { useRef } from 'preact/hooks';

import { hasDirectoryPicker, showDirectoryPicker, isAbort } from '../../../platform/fsa';
import { notify } from '../../../core/notify';

export function BatchPanel() {
  const t = useTranslation();
  const abortControllerRef = useRef<AbortController | null>(null);

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
      notify('warning', 'Directory selection unavailable', {
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
      notify('warning', 'Directory selection unavailable', {
        detail:
          'Folder processing requires a browser with File System Access support (Chrome or Edge).'
      });
      return;
    }
    try {
      const dir = await showDirectoryPicker({ mode: 'readwrite' });
      outputDirHandle.value = dir;
    } catch (e) {
      reportPickerFailure('Output folder selection failed', e);
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

  const handleSaveRecipe = () => {
    const name = window.prompt('Recipe name:');
    if (!name) return;
    const newRecipe: Recipe = {
      id: crypto.randomUUID(),
      name,
      tools: ['watermark', 'normalize', 'nup', 'compress'],
      settings: {
        compress: snapshot<CompressSettings>(compressSettings.value),
        watermark: snapshot<WatermarkSettings>(watermarkSettings.value),
        headerFooter: snapshot<HeaderFooterSettings>(headerFooterSettings.value),
        nup: snapshot<NUpSettings>(nupSettings.value),
        normalize: snapshot<NormalizeSettings>(normalizeSettings.value)
      }
    };
    savedRecipes.value = [...savedRecipes.value, newRecipe];
    activeRecipeId.value = newRecipe.id;
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
        <Button onClick={handleSelectOutput} variant="secondary">
          {outputDirHandle.value ? `Output: ${outputDirHandle.value.name}` : 'Select Output Folder'}
        </Button>
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
        <Button onClick={handleSaveRecipe} variant="secondary">
          {t('Save current as recipe')}
        </Button>
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
        <div className={panelStyles.section}>
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
            {batchProgress.value.notes.length} {t('written unchanged')}
          </p>
          <ul style={{ margin: 0, paddingInlineStart: '20px', fontSize: '0.85em' }}>
            {batchProgress.value.notes.map(note => (
              <li key={`${note.file}-${note.detail}`}>
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
            !inputDirHandle.value || !outputDirHandle.value || batchProgress.value.isProcessing
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
