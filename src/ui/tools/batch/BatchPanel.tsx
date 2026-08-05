import { Button } from '../../components/Button';
import { Select } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import {
  inputDirHandle,
  outputDirHandle,
  savedRecipes,
  activeRecipeId,
  batchProgress,
  Recipe
} from './state';
import { compressSettings } from '../compress/state';
import { watermarkSettings, headerFooterSettings } from '../watermark/state';
import { nupSettings } from '../nup/state';
import type { NUpSettings } from '../nup/state';
import { normalizeSettings } from '../normalize/state';
import type { NormalizeSettings } from '../normalize/state';
import { runBatch } from './runner';
import { useTranslation } from '../../../core/i18n';

export function BatchPanel() {
  const t = useTranslation();
  const handleSelectInput = async () => {
    try {
      // @ts-expect-error TODO: fix type
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      inputDirHandle.value = dir;
    } catch (e) {
      console.error(e);
    }
  };

  const handleSelectOutput = async () => {
    try {
      // @ts-expect-error TODO: fix type
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      outputDirHandle.value = dir;
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveRecipe = () => {
    const name = window.prompt('Recipe name:');
    if (!name) return;
    const newRecipe: Recipe = {
      id: crypto.randomUUID(),
      name,
      tools: [], // We could allow the user to select which tools to apply, or apply all active
      settings: {
        compress: { ...compressSettings.value },
        watermark: { ...watermarkSettings.value },
        headerFooter: { ...headerFooterSettings.value },
        nup: nupSettings.value as NUpSettings,
        normalize: normalizeSettings.value as NormalizeSettings
      }
    };
    savedRecipes.value = [...savedRecipes.value, newRecipe];
    activeRecipeId.value = newRecipe.id;
  };

  const handleRun = () => {
    runBatch();
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
        <label className={panelStyles.label}>{t('Recipe')}</label>
        <Select
          id="batch-recipe"
          value={activeRecipeId.value || ''}
          onChange={val => (activeRecipeId.value = val || null)}
          options={[
            { value: '', label: 'None (Use current settings)' },
            ...savedRecipes.value.map(r => ({ value: r.id, label: r.name }))
          ]}
        />
        <Button onClick={handleSaveRecipe} variant="secondary">
          {t('Save current as recipe')}
        </Button>
      </div>

      {batchProgress.value.isProcessing && (
        <div className={panelStyles.section}>
          <p>
            {t('Processing:')}
            {batchProgress.value.currentFile}
          </p>
          <p>
            {batchProgress.value.completed} / {batchProgress.value.total} {t('completed')}
          </p>
          <p>
            {batchProgress.value.failed} {t('failed')}
          </p>
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
      </div>
    </>
  );
}
