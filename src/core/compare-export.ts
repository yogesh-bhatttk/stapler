import type { ExportVisualDiffOptions } from './visual-diff-export';
import type { StaplerDoc } from './store';
import { exportTextDiff } from './text-diff-export';
import { exportVisualDiff } from './visual-diff-export';
import { exportRedlinePdf, type ExportRedlineOptions } from './redline-export';

export interface ExportCompareOptions extends ExportVisualDiffOptions {
  diffMode: 'visual' | 'text' | 'redline';
  unchangedPages?: ExportRedlineOptions['unchangedPages'];
}

export async function exportComparePdf(
  docA: StaplerDoc,
  docB: StaplerDoc,
  options: ExportCompareOptions
): Promise<Uint8Array> {
  if (options.diffMode === 'text') {
    return exportTextDiff(docA, docB);
  }

  if (options.diffMode === 'redline') {
    return exportRedlinePdf(docA, docB, options);
  }

  return exportVisualDiff(docA, docB, undefined, options);
}
