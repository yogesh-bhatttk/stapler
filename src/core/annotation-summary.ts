import type { StaplerDoc } from './store';
import {
  formatPageNumber,
  getPositionString,
  getTypeLabel,
  sortAnnotations,
  type SummaryAnnotation
} from './annotation-summary-shared';
import { cancelled } from './errors';
import { processWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';

export type { SummaryAnnotation } from './annotation-summary-shared';

/**
 * Generates a clean plain-text summary of all annotations in `doc`.
 */
export function exportAnnotationSummaryText(
  doc: { name?: string; pages?: { key: string }[] } | StaplerDoc,
  annotations: SummaryAnnotation[]
): string {
  const docName = doc.name || 'Document';
  const pages = doc.pages || [];
  const lines: string[] = [
    `========================================`,
    `ANNOTATION SUMMARY: ${docName}`,
    `Total Annotations: ${annotations.length}`,
    `========================================`,
    ''
  ];

  const sorted = sortAnnotations(annotations, pages);

  sorted.forEach((ann, i) => {
    const pageNum = formatPageNumber(ann, pages);
    const typeLabel = getTypeLabel(ann.type);
    const posStr = getPositionString(ann);
    const author = ann.author || 'Anonymous';
    const date = ann.date || 'N/A';
    const textContent = ann.text || ann.data || '(No text content)';

    lines.push(`[Note #${i + 1}] ${typeLabel}`);
    lines.push(`Page: ${pageNum}`);
    lines.push(`Author: ${author}`);
    lines.push(`Date: ${date}`);
    lines.push(`Position: ${posStr}`);
    lines.push(`Text: ${textContent}`);
    lines.push(`----------------------------------------`);
  });

  return lines.join('\n');
}

/** Only the fields the summary reads, so nothing uncloneable crosses to the worker. */
function plainAnnotation(ann: SummaryAnnotation): SummaryAnnotation {
  return {
    id: ann.id,
    type: ann.type,
    color: ann.color,
    strokeWidth: ann.strokeWidth,
    points: ann.points?.map(p => ({ x: p.x, y: p.y })),
    rect: ann.rect && {
      x: ann.rect.x,
      y: ann.rect.y,
      width: ann.rect.width,
      height: ann.rect.height
    },
    x: ann.x,
    y: ann.y,
    text: ann.text,
    data: ann.data,
    author: ann.author,
    date: ann.date,
    pageKey: ann.pageKey,
    pageIndex: ann.pageIndex
  };
}

/**
 * ANN-04: Export annotation summary.
 * Construct a clean printable PDF summary listing each note's page, position, author/date, and text content.
 *
 * HRD-24 §12.11: runs under the caller's `useJob` — determinate progress
 * (layout 0–0.85, writing 0.85–1) and cancellation through `options.signal`.
 * The PDF itself is built in the process worker
 * (`workers/annotation-summary-pdf.ts`), never on the main thread; progress
 * and cancel cross over the worker job protocol. A cancel throws
 * `UserCancelled` and nothing is returned or saved.
 */
export async function exportAnnotationSummary(
  doc: { name?: string; pages?: { key: string }[] } | StaplerDoc,
  annotations: SummaryAnnotation[],
  options: JobOptions = {}
): Promise<Uint8Array> {
  if (options.signal?.aborted) throw cancelled();
  const input = {
    name: doc.name || 'Document',
    pageKeys: (doc.pages || []).map(page => page.key)
  };
  const plain = annotations.map(plainAnnotation);
  const bytes = await processWorker.lease(api =>
    api.buildAnnotationSummary(input, plain, createJobHandle(options))
  );
  if (options.signal?.aborted) throw cancelled();
  return bytes;
}
