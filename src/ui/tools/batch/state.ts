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

export const savedRecipes = signal<Recipe[]>(
  JSON.parse(localStorage.getItem('stapler:recipes') || '[]')
);

savedRecipes.subscribe(recipes => {
  localStorage.setItem('stapler:recipes', JSON.stringify(recipes));
});

export const activeRecipeId = signal<string | null>(null);

export const inputDirHandle = signal<FileSystemDirectoryHandle | null>(null);
export const outputDirHandle = signal<FileSystemDirectoryHandle | null>(null);

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  currentFile: string;
  isProcessing: boolean;
}

export const batchProgress = signal<BatchProgress>({
  total: 0,
  completed: 0,
  failed: 0,
  currentFile: '',
  isProcessing: false
});

/**
 * BAT-03 — output filename pattern. Tokens: {basename}, {index}, {date}.
 * Defaults to '{basename}' which preserves the pre-BAT-03 behaviour exactly.
 */
export const outputPattern = signal<string>(
  localStorage.getItem('stapler:batch:outputPattern') ?? '{basename}'
);

outputPattern.subscribe(p => {
  localStorage.setItem('stapler:batch:outputPattern', p);
});
