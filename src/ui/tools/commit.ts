/**
 * What the action bar's primary button does, per tool.
 *
 * This was a 100-line `if (isSplitRoute) … else if (isPdfToImgRoute) …` chain inside
 * the action-bar component, mixing worker orchestration, filename policy, and
 * `alert()` reporting. Splitting it out means the action bar only renders, and a new
 * tool adds an entry here instead of another branch.
 */
import { platform } from '../../platform/current';
import { confirmAction, notify } from '../../core/notify';
import { internal } from '../../core/errors';
import {
  applyRedactions,
  compressDocument,
  composeDocument,
  currentDocumentBytes,
  extractDocumentText,
  pagesToImageArchive,
  planCompression,
  splitBoundaries,
  splitDocument
} from '../../core/operations';
import { processWorker } from '../../core/workers';
import {
  activeDoc,
  deletePages,
  registerSource,
  replaceWithSource,
  selectedPageKeys,
  type StaplerDoc
} from '../../core/store';
import { formatBytes } from '../components/Feedback';
import type { JobOptions } from '../../core/workers/protocol';
import type { ToolId } from '../../core/tools';
import { compressSettings } from './compress/state';
import { pdfToImageSettings, removeBlanksThreshold, splitSettings } from './state';
import { extractSettings } from './extract/state';
import { pendingRedactions, redactionReport } from './redact/state';
import { scrubSettings } from './metadata/state';
import { renderWorker } from '../../core/workers';

/** Strips the extension so suffixes can be appended without doubling `.pdf`. */
function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'document';
}

async function save(bytes: Uint8Array, name: string): Promise<boolean> {
  const saved = await platform.saveFileAs(bytes, name);
  if (saved) notify('success', `Saved ${name}`, { detail: formatBytes(bytes.byteLength) });
  return saved;
}

export interface CommitContext {
  doc: StaplerDoc;
  job: JobOptions;
}

type CommitHandler = (context: CommitContext) => Promise<void>;

const exportComposed: CommitHandler = async ({ doc, job }) => {
  const bytes = await composeDocument({ pages: doc.pages, annotations: doc.annotations }, job);
  await save(bytes, `${stem(doc.name)}-stapler.pdf`);
};

const HANDLERS: Record<ToolId, CommitHandler> = {
  merge: exportComposed,
  organize: exportComposed,
  insert: exportComposed,
  extract: exportComposed,

  split: async ({ doc, job }) => {
    const settings = splitSettings.value;

    if (settings.mode === 'extract') {
      const selected = doc.pages.filter(p => selectedPageKeys.value.has(p.key));
      if (selected.length === 0) {
        notify('warning', 'Select the pages to extract first.', {
          detail: 'Click pages in the grid, or press Space to select the focused page.'
        });
        return;
      }
      const bytes = await composeDocument({ pages: selected, annotations: doc.annotations }, job);
      await save(bytes, `${stem(doc.name)}-extract.pdf`);
      return;
    }

    const boundaries = splitBoundaries(settings.mode, doc.pages.length, {
      every: settings.everyN,
      custom: settings.customBoundaries
    });
    if (boundaries.length === 0) {
      notify('warning', 'That produces a single file.', {
        detail: 'Choose split points inside the document, or use Extract instead.'
      });
      return;
    }

    const result = await splitDocument(
      {
        pages: doc.pages,
        annotations: doc.annotations,
        boundaries,
        baseName: stem(doc.name)
      },
      job
    );

    if (!result.isZip) {
      await save(result.bytes, `${stem(doc.name)}-part-01.pdf`);
      return;
    }
    await save(result.bytes, `${stem(doc.name)}-split.zip`);
  },

  'remove-blanks': async ({ doc }) => {
    const selected = [...selectedPageKeys.value];
    if (selected.length === 0) {
      notify('warning', 'Nothing is selected.', {
        detail: 'Run Detect blank pages, review what it found, then confirm.'
      });
      return;
    }
    // OPS-05: nothing is removed without explicit confirmation.
    const confirmed = await confirmAction({
      title: `Delete ${selected.length} page${selected.length === 1 ? '' : 's'}?`,
      body: 'They are removed from the workspace only. Undo with ⌘Z; the file on disk is untouched until you export.',
      confirmLabel: 'Delete pages',
      tone: 'danger'
    });
    if (confirmed) deletePages(doc.id, selected);
  },

  'pdf-to-img': async ({ doc, job }) => {
    const settings = pdfToImageSettings.value;
    const bytes = await currentDocumentBytes(job);
    const selected = selectedPageKeys.value;
    const indices = doc.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => selected.size === 0 || selected.has(page.key))
      .map(({ index }) => index);

    const archive = await pagesToImageArchive(bytes, indices, settings.format, settings.dpi, job);
    await save(archive, `${stem(doc.name)}-${settings.dpi}dpi.zip`);
  },

  compress: async ({ doc, job }) => {
    const settings = compressSettings.value;
    const original = await currentDocumentBytes(job);

    // CMP-04: tell the truth *before* spending the user's time, not after.
    const report = await planCompression(original, settings, job);
    if (report.alreadyOptimized) {
      const proceed = await confirmAction({
        title: 'Already optimized',
        body:
          `Only about ${Math.max(0, Math.round(report.estimatedFraction * 100))}% could be saved from ` +
          `${formatBytes(report.originalBytes)}. ${report.plan.skipped.length > 0 ? `Some content is left untouched: ${report.plan.skipped.join('; ')}. ` : ''}` +
          'Compressing anyway will take time for little gain.',
        confirmLabel: 'Compress anyway',
        cancelLabel: 'Leave it alone'
      });
      if (!proceed) return;
    }

    const result = await compressDocument(original, settings, report, job);
    if (result.keptOriginal) {
      notify('warning', 'Kept the original file.', {
        detail:
          'Re-encoding produced a larger file, so Stapler discarded it. Nothing was written. ' +
          'This document is already as small as it usefully gets.',
        timeout: 0
      });
      return;
    }

    const saved = await save(result.bytes, `${stem(doc.name)}-compressed.pdf`);
    if (saved) {
      const percent = Math.round((1 - result.bytes.byteLength / result.originalBytes) * 100);
      notify('success', `Reduced by ${percent}%`, {
        detail: `${formatBytes(result.originalBytes)} → ${formatBytes(result.bytes.byteLength)}`
      });
    }
  },

  cleanup: async ({ doc, job }) => {
    // The cleanup editor writes its result straight into the document, so committing
    // is an ordinary export of whatever the workspace now holds.
    const bytes = await composeDocument({ pages: doc.pages, annotations: doc.annotations }, job);
    await save(bytes, `${stem(doc.name)}-cleaned.pdf`);
  },

  sign: async ({ doc, job }) => {
    if (doc.annotations.length === 0) {
      notify('warning', 'Nothing has been placed yet.', {
        detail: 'Pick a signature or stamp from the panel, then click the page.'
      });
      return;
    }
    const bytes = await composeDocument({ pages: doc.pages, annotations: doc.annotations }, job);
    await save(bytes, `${stem(doc.name)}-signed.pdf`);
  },

  redact: async ({ doc, job }) => {
    const regions = pendingRedactions.value;
    if (regions.length === 0) {
      notify('warning', 'No regions are marked.', {
        detail: 'Draw a rectangle on the page, or search for text to mark every occurrence.'
      });
      return;
    }

    const original = await currentDocumentBytes(job);
    const outcome = await applyRedactions(original, regions, job);
    redactionReport.value = outcome;

    // RED-03: saving is blocked when any region fails verification.
    if (!outcome.verified) {
      notify('danger', 'Redaction could not be verified — nothing was saved.', {
        detail:
          'The report lists which regions failed and why. Your original document is untouched.',
        timeout: 0
      });
      return;
    }

    const source = {
      id: crypto.randomUUID(),
      name: `${stem(doc.name)}-redacted.pdf`,
      bytes: outcome.bytes,
      pageCount: doc.pages.length,
      pageSizes: [] as { width: number; height: number }[]
    };
    // Re-read geometry from the rebuilt bytes: rasterised pages may differ.
    const info = await renderWorker.lease(api => api.loadDocument(outcome.bytes));
    source.pageCount = info.pageCount;
    source.pageSizes = info.pageSizes;
    await renderWorker.lease(api => api.closeDocument(info.handle));

    registerSource(source);
    replaceWithSource(doc.id, source);
    pendingRedactions.value = [];
    notify('success', 'Redaction verified and applied.', {
      detail: `Pages ${outcome.rasterizedPages.map(p => p + 1).join(', ')} are now images, so their text is no longer selectable. Export to save.`,
      timeout: 0
    });
  },

  metadata: async ({ doc, job }) => {
    const original = await currentDocumentBytes(job);
    const scrubbed = await processWorker.lease(api =>
      api.scrubMetadata(original, scrubSettings.value)
    );
    await save(scrubbed, `${stem(doc.name)}-scrubbed.pdf`);
  }
};

export async function commitTool(toolId: ToolId, job: JobOptions): Promise<void> {
  const doc = activeDoc.value;
  if (!doc) throw internal('No document is open.');
  const handler = HANDLERS[toolId];
  if (!handler) throw internal(`No commit action is defined for the ${toolId} tool.`);
  await handler({ doc, job });
}

/** Re-exported so the extract panel can share the text pipeline. */
export { extractDocumentText, extractSettings, removeBlanksThreshold };
