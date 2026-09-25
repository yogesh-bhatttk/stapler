import { signal } from '@preact/signals';
import type { ToolId } from '../../../core/tools';
import type { CompressSettings } from '../compress/state';
import type { WatermarkSettings, HeaderFooterSettings } from '../watermark/state';
import type { NUpSettings } from '../nup/state';
import type { NormalizeSettings } from '../normalize/state';

export interface Recipe {
  id: string;
  name: string;
  tools: ToolId[];
  settings: {
    compress?: CompressSettings;
    watermark?: WatermarkSettings;
    headerFooter?: HeaderFooterSettings;
    nup?: NUpSettings;
    normalize?: NormalizeSettings;
  };
}

import { listRecipes, putRecipe, deleteRecipe } from '../../../core/db';

/**
 * localStorage throws in Safari private mode and other hardened contexts, and
 * does not exist at all in a worker or test realm. These settings are
 * conveniences, so a failed read falls back to the default and a failed write
 * is dropped — never an exception at module load, which took down every module
 * importing this one.
 */
function readLocal(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered for next time; the in-memory value still applies.
  }
}

export const savedRecipes = signal<Recipe[]>([]);
export const recipesLoaded = signal<boolean>(false);

export async function loadRecipes() {
  if (recipesLoaded.value) return;
  const recipes = await listRecipes();
  const legacyStr = readLocal('stapler:recipes');
  if (legacyStr && recipes.length === 0) {
    const legacy = JSON.parse(legacyStr) as Recipe[];
    for (const r of legacy) {
      await putRecipe(r);
      recipes.push(r);
    }
    writeLocal('stapler:recipes', null);
  }
  savedRecipes.value = recipes as Recipe[];
  recipesLoaded.value = true;
}

export async function addRecipe(recipe: Recipe) {
  await putRecipe(recipe);
  savedRecipes.value = [...savedRecipes.value, recipe];
}

export async function removeRecipe(id: string) {
  await deleteRecipe(id);
  savedRecipes.value = savedRecipes.value.filter(r => r.id !== id);
}

export const activeRecipeId = signal<string | null>(null);

import type { FsaDirectoryHandle, FsaFileHandle } from '../../../platform/fsa';

export const inputDirHandle = signal<FsaDirectoryHandle | FileSystemDirectoryHandle | null>(null);
export const outputDirHandle = signal<FsaDirectoryHandle | FileSystemDirectoryHandle | null>(null);
export const outputZipHandle = signal<FsaFileHandle | FileSystemFileHandle | null>(null);
export const outputFormat = signal<'directory' | 'zip'>('directory');

/**
 * One thing that happened to one file that the run summary has to mention.
 *
 * `kept-original` is the compress fallback (CMP-04): the compressed result came
 * out no smaller than the input, so the original was written through unchanged.
 * That is the correct outcome, but silently emitting a byte-identical copy left
 * the user believing a folder of files had been compressed when it had not.
 */
export interface BatchNote {
  file: string;
  kind: 'kept-original' | 'failed' | 'metadata-scrubbed';
  detail: string;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  currentFile: string;
  isProcessing: boolean;
  /** Per-file outcomes worth telling the user about, in the order they happened. */
  notes: BatchNote[];
}

export const batchProgress = signal<BatchProgress>({
  total: 0,
  completed: 0,
  failed: 0,
  currentFile: '',
  isProcessing: false,
  notes: []
});

/**
 * BAT-03 — output filename pattern. Tokens: {basename}, {index}, {date}.
 * Defaults to '{basename}' which preserves the pre-BAT-03 behaviour exactly.
 */
export const outputPattern = signal<string>(
  readLocal('stapler:batch:outputPattern') ?? '{basename}'
);

outputPattern.subscribe(p => {
  writeLocal('stapler:batch:outputPattern', p);
});

/** RED-09 — scrub every finding RED-04 would report, independently per file. */
export const scrubMetadataInBatch = signal<boolean>(
  readLocal('stapler:batch:scrubMetadata') === 'true'
);

scrubMetadataInBatch.subscribe(v => {
  writeLocal('stapler:batch:scrubMetadata', String(v));
});
