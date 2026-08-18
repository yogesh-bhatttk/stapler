import { translate } from '../../../core/i18n';
import { ChevronDown, ChevronUp } from 'lucide-preact';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Checkbox, Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
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

import { useRef, useEffect, useState } from 'preact/hooks';

import {
  hasDirectoryPicker,
  showDirectoryPicker,
  isAbort,
  showSaveFilePicker
} from '../../../platform/fsa';
import { notify } from '../../../core/notify';

/** The only tools a recipe can chain, in the order they'd normally run. */
const RECIPE_TOOL_CHOICES: { id: Recipe['tools'][number]; label: string }[] = [
  { id: 'watermark', label: 'Watermark' },
  { id: 'normalize', label: 'Normalize' },
  { id: 'nup', label: 'N-up' },
  { id: 'compress', label: 'Compress' }
];

export function BatchPanel() {
  const t = useTranslation();
  const abortControllerRef = useRef<AbortController | null>(null);
  const [recipeFormOpen, setRecipeFormOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftTools, setDraftTools] = useState<Recipe['tools']>([]);

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

  const openRecipeForm = () => {
    setDraftName('');
    setDraftTools(RECIPE_TOOL_CHOICES.map(c => c.id));
    setRecipeFormOpen(true);
  };

  const toggleDraftTool = (id: Recipe['tools'][number], included: boolean) => {
    setDraftTools(prev => (included ? [...prev, id] : prev.filter(t => t !== id)));
  };

  const moveDraftTool = (id: Recipe['tools'][number], delta: 1 | -1) => {
    setDraftTools(prev => {
      const index = prev.indexOf(id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSaveRecipe = async () => {
    const name = draftName.trim();
    if (!name || draftTools.length === 0) return;

    const newRecipe: Recipe = {
      id: crypto.randomUUID(),
      name,
      tools: draftTools,
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
    setRecipeFormOpen(false);
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
          <Button onClick={openRecipeForm} variant="secondary">
            {t('Save current as recipe')}
          </Button>
          <Button onClick={handleExportRecipes} variant="secondary">
            {t('Export')}
          </Button>
          <Button onClick={handleImportRecipes} variant="secondary">
            {t('Import')}
          </Button>
        </div>

        {recipeFormOpen && (
          <div className={panelStyles.section} style={{ marginTop: '8px' }}>
            <Field label={t('Recipe name')}>
              {id => (
                <input
                  id={id}
                  type="text"
                  value={draftName}
                  onInput={e => setDraftName((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </Field>

            <p style={{ fontSize: '0.85em', margin: '8px 0 4px', opacity: 0.8 }}>
              {t('Tools to run, in order')}
            </p>
            {RECIPE_TOOL_CHOICES.map(choice => {
              const index = draftTools.indexOf(choice.id);
              const included = index !== -1;
              return (
                <div key={choice.id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Checkbox
                    label={included ? `${index + 1}. ${choice.label}` : choice.label}
                    checked={included}
                    onChange={checked => toggleDraftTool(choice.id, checked)}
                  />
                  {included && (
                    <>
                      <IconButton
                        icon={ChevronUp}
                        size="compact"
                        aria-label={`Move ${choice.label} earlier`}
                        disabled={index === 0}
                        onClick={() => moveDraftTool(choice.id, -1)}
                      />
                      <IconButton
                        icon={ChevronDown}
                        size="compact"
                        aria-label={`Move ${choice.label} later`}
                        disabled={index === draftTools.length - 1}
                        onClick={() => moveDraftTool(choice.id, 1)}
                      />
                    </>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <Button
                onClick={handleSaveRecipe}
                disabled={!draftName.trim() || draftTools.length === 0}
              >
                {t('Save recipe')}
              </Button>
              <Button variant="secondary" onClick={() => setRecipeFormOpen(false)}>
                {t('Cancel')}
              </Button>
            </div>
          </div>
        )}
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
