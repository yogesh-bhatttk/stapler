import type { ExportVisualDiffOptions } from './visual-diff-export';
import type { StaplerDoc } from './store';
import { exportTextDiff } from './text-diff-export';
import { exportVisualDiff } from './visual-diff-export';

export interface ExportCompareOptions extends ExportVisualDiffOptions {
  diffMode: 'visual' | 'text';
}

export async function exportComparePdf(
  docA: StaplerDoc,
  docB: StaplerDoc,
  options: ExportCompareOptions
): Promise<Uint8Array> {
  if (options.diffMode === 'text') {
    return exportTextDiff(docA, docB);
  }

  return exportVisualDiff(docA, docB, [], options);
}
