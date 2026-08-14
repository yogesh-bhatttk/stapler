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
  compressToTargetSize,
  composeDocument,
  currentDocumentBytes,
  extractDocumentText,
  fillFormFields,
  pagesToImageArchive,
  planCompression,
  sanitizeFileStem,
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
import {
  compressMode,
  compressSettings,
  compressTarget,
  compressTargetOutcome,
  targetSizeBytes
} from './compress/state';
import { pdfToImageSettings, removeBlanksThreshold, splitSettings } from './state';
import { extractSettings } from './extract/state';
import { formFields, formValues } from './sign/state';
import { XFA_MESSAGE } from '../../core/pdf/xfa';
import { pendingRedactions, redactionReport } from './redact/state';
import { protection, protectionActive, protectionIssue } from './protect/state';
import type { ProtectionSettings } from '../../core/pdf/encrypt';
import { scrubSettings } from './metadata/state';
import { renderWorker } from '../../core/workers';

/** Strips the extension so suffixes can be appended without doubling `.pdf`. */
function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'document';
}

/**
 * RED-06 — encrypts what is about to be written, if the user asked for it.
 *
 * Returns the bytes to write, or `null` when the export must not happen: an
 * encryption failure has to stop the save outright, because writing the
 * unencrypted bytes instead would hand the user a file they believe is protected.
 * Applied here rather than in each handler so every tool's export is covered by
 * one rule, and so nothing forks a second save path.
 */
async function applyProtection(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const issue = protectionIssue();
  if (issue) {
    notify('danger', 'Nothing was saved.', {
      detail: `${issue} Fix it in the Metadata & privacy panel, or turn password protection off.`,
      timeout: 0
    });
    return null;
  }
  if (!protectionActive()) return bytes;

  if (!name.toLowerCase().endsWith('.pdf')) {
    // A ZIP has no PDF security handler to carry the password, and encrypting the
    // members individually is a different feature than the one that was asked for.
    notify('warning', 'This export is a ZIP, so no password was applied.', {
      detail: 'Export a single PDF to password-protect it.',
      timeout: 0
    });
    return bytes;
  }

  const state = protection.value;
  // The confirmation field and the on/off flag are UI state; only the handler's
  // own settings cross into the worker.
  const settings: ProtectionSettings = {
    userPassword: state.userPassword,
    ownerPassword: state.ownerPassword,
    allowPrinting: state.allowPrinting,
    allowCopying: state.allowCopying,
    allowModifying: state.allowModifying
  };
  try {
    return await processWorker.lease(api => api.protectDocument(bytes, settings));
  } catch (err) {
    notify('danger', 'Could not password-protect the file — nothing was saved.', {
      detail: `${err instanceof Error ? err.message : String(err)} Your document is unchanged.`,
      timeout: 0
    });
    return null;
  }
}

/**
 * DOC-05 — offers save-over-original when the document's handle supports it.
 *
 * Always asks rather than defaulting to overwrite: the file this document came
 * from is not necessarily what the caller's suggested `name` refers to (most
 * commit paths suggest a derived name like `contract-compressed.pdf`), and
 * silently overwriting the original the first time a user clicks the one
 * button that used to always mean "save a new file" is exactly the kind of
 * surprise this product's error-handling philosophy exists to avoid.
 */
async function save(doc: StaplerDoc, bytes: Uint8Array, name: string): Promise<boolean> {
  const protectedBytes = await applyProtection(bytes, name);
  if (!protectedBytes) return false;
  const wasProtected = protectedBytes !== bytes;
  bytes = protectedBytes;
  const note = (size: string) => (wasProtected ? `${size} · password required to open` : size);

  if (doc.sourceHandle?.writable) {
    const overwrite = await confirmAction({
      title: `Save changes to ${doc.name}?`,
      body: 'Save over the original file, or keep it and save a new file instead.',
      confirmLabel: 'Save over original',
      cancelLabel: 'Save as new file'
    });
    if (overwrite) {
      const saved = await platform.saveOver(doc.sourceHandle.fileId, bytes);
      if (saved) {
        notify('success', `Saved ${doc.name}`, { detail: note(formatBytes(bytes.byteLength)) });
      } else {
        notify('warning', 'Could not save over the original file.', {
          detail: 'Nothing was overwritten. Try again to save a new file instead.'
        });
      }
      return saved;
    }
  }

  const saved = await platform.saveFileAs(bytes, name);
  if (saved) notify('success', `Saved ${name}`, { detail: note(formatBytes(bytes.byteLength)) });
  return saved;
}

export interface CommitContext {
  doc: StaplerDoc;
  job: JobOptions;
}

type CommitHandler = (context: CommitContext) => Promise<void>;

import { cropBoxes } from './crop/state';
import { batesSettings, watermarkSettings, headerFooterSettings } from './watermark/state';
import {
  entriesToNodes,
  outlineDocId,
  outlineEdited,
  outlineTree,
  topLevelSlices
} from './outline/state';
import { nupSettings } from './nup/state';
import { pageAnnotations } from './annotate/state';

import { type AnnotationSource } from '../../core/workers/process.worker';

function getLayerAnnotations(): AnnotationSource[] {
  const result: AnnotationSource[] = [];
  for (const [pageKey, anns] of Object.entries(pageAnnotations.value)) {
    for (const ann of anns) {
      result.push({ ...ann, pageKey });
    }
  }
  return result;
}

/** OPS-11 — the Bates stamp, or nothing when the user has not switched it on. */
function getBates() {
  const settings = batesSettings.value;
  if (!settings.enabled) return undefined;
  return {
    prefix: settings.prefix,
    digits: settings.digits,
    start: settings.start,
    position: settings.position,
    fontSize: settings.fontSize
  };
}

/**
 * OPS-10 — the edited outline, or `undefined` to leave the document's own alone.
 *
 * Only the tree loaded *for this document*, and only once the user has actually
 * changed it. `outlineTree` is a single signal, so another document's bookmarks
 * would point at pages that are not in this one; and an unedited tree must not be
 * written back at all, because it was read from the first page's source document
 * and would silently drop the outlines a second, merged-in document contributed
 * through OPS-01.
 */
function getOutline(doc: StaplerDoc) {
  if (outlineDocId.value !== doc.id || !outlineEdited.value) return undefined;
  return entriesToNodes(
    outlineTree.value,
    doc.pages.map(page => page.key)
  );
}

/** OPS-12 — the loaded outline's top-level entries, as split boundaries and names. */
function topLevelBookmarkSlices(doc: StaplerDoc) {
  const tree = outlineDocId.value === doc.id ? outlineTree.value : [];
  return topLevelSlices(
    tree,
    doc.pages.map(page => page.key)
  );
}

// Normalize is deliberately not read here: it is its own tool, applied only via
// `currentDocumentBytes(job, true)` in its own handler below. Reading the global
// `normalizeSettings` signal in every tool's export was OPS-09 — it silently
// resized pages on merge/organize/crop/watermark/etc. once the Normalize panel
// had ever been opened, since the signal defaults to non-null on first mount.
const exportComposed: CommitHandler = async ({ doc, job }) => {
  const bytes = await composeDocument(
    {
      pages: doc.pages,
      annotations: doc.annotations,
      cropBoxes: cropBoxes.value,
      watermark: watermarkSettings.value,
      headerFooter: headerFooterSettings.value,
      nup: nupSettings.value,
      layerAnnotations: getLayerAnnotations(),
      outline: getOutline(doc),
      bates: getBates()
    },
    job
  );
  await save(doc, bytes, `${stem(doc.name)}-stapler.pdf`);
};

const HANDLERS: Record<ToolId, CommitHandler> = {
  merge: exportComposed,
  organize: exportComposed,
  insert: exportComposed,
  extract: exportComposed,
  nup: exportComposed,
  crop: exportComposed,
  watermark: exportComposed,
  outline: exportComposed,
  annotate: exportComposed,

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
      const bytes = await composeDocument(
        { pages: selected, annotations: doc.annotations, layerAnnotations: getLayerAnnotations() },
        job
      );
      await save(doc, bytes, `${stem(doc.name)}-extract.pdf`);
      return;
    }

    // OPS-12 — the boundaries and the filenames both come from the outline.
    const bookmarks = settings.mode === 'bookmarks' ? topLevelBookmarkSlices(doc) : null;
    if (settings.mode === 'bookmarks' && (!bookmarks || bookmarks.length === 0)) {
      notify('warning', 'This document has no top-level bookmarks.', {
        detail: 'Add them in the Bookmarks tool, or choose another split mode.'
      });
      return;
    }

    const boundaries = splitBoundaries(settings.mode, doc.pages.length, {
      every: settings.everyN,
      custom: settings.customBoundaries,
      bookmarkStarts: bookmarks?.map(bookmark => bookmark.pageIndex)
    });
    if (boundaries.length === 0 && !bookmarks) {
      notify('warning', 'That produces a single file.', {
        detail: 'Choose split points inside the document, or use Extract instead.'
      });
      return;
    }

    const fileNames = bookmarks?.map((bookmark, index) =>
      sanitizeFileStem(
        bookmark.title,
        `${stem(doc.name)}-part-${String(index + 1).padStart(2, '0')}`
      )
    );

    const result = await splitDocument(
      {
        pages: doc.pages,
        annotations: doc.annotations,
        layerAnnotations: getLayerAnnotations(),
        bates: getBates(),
        boundaries,
        baseName: stem(doc.name),
        fileNames
      },
      job
    );

    if (!result.isZip) {
      // A single bookmark means a single file, which is still a valid answer — it
      // just keeps the bookmark's name rather than arriving in a one-entry ZIP.
      const single = fileNames?.[0] ?? `${stem(doc.name)}-part-01`;
      await save(doc, result.bytes, `${single}.pdf`);
      return;
    }
    await save(doc, result.bytes, `${stem(doc.name)}-split.zip`);
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
    await save(doc, archive, `${stem(doc.name)}-${settings.dpi}dpi.zip`);
  },

  compress: async ({ doc, job }) => {
    const settings = compressSettings.value;
    const original = await currentDocumentBytes(job);

    // DOC-07 — "aim for a size" replaces the manual DPI/quality pair with a
    // measured search. Everything it reports is the byte length of the file it
    // is about to write; when the floor cannot reach the target it says so and
    // asks, rather than saving a file that quietly misses what was asked for.
    if (compressMode.value === 'target') {
      const targetBytes = targetSizeBytes(compressTarget.value);
      if (original.byteLength <= targetBytes) {
        notify('info', 'Already under the target.', {
          detail: `${doc.name} is ${formatBytes(original.byteLength)}, which is already at or under ${formatBytes(targetBytes)}. Nothing was changed.`
        });
        return;
      }

      const outcome = await compressToTargetSize(original, targetBytes, job);
      compressTargetOutcome.value = {
        targetBytes,
        achievedBytes: outcome.achievedBytes,
        originalBytes: outcome.originalBytes,
        reached: outcome.reachedTarget,
        settings: outcome.settings,
        attempts: outcome.trials.length,
        skipped: outcome.plan?.skipped ?? []
      };
      // Show the preview at the settings the search actually landed on.
      if (outcome.settings) compressSettings.value = { ...outcome.settings };

      if (outcome.keptOriginal) {
        notify('warning', 'Kept the original file.', {
          detail:
            `Every setting Stapler tried produced a larger file than ${formatBytes(outcome.originalBytes)}, ` +
            'so all of them were discarded and nothing was written. This document is already as small as it usefully gets.',
          timeout: 0
        });
        return;
      }

      if (!outcome.reachedTarget) {
        const skipped =
          outcome.plan && outcome.plan.skipped.length > 0
            ? ` Some content cannot be re-encoded safely and stays at full size: ${outcome.plan.skipped.join('; ')}.`
            : '';
        const proceed = await confirmAction({
          title: `Could not reach ${formatBytes(targetBytes)}`,
          body:
            `The smallest Stapler can produce without destroying this document is ${formatBytes(outcome.achievedBytes)}, ` +
            `at ${outcome.settings?.dpi} DPI and ${Math.round((outcome.settings?.quality ?? 0) * 100)}% quality — ` +
            `measured, after ${outcome.trials.length} attempt(s).${skipped} Save that file instead, or keep the original?`,
          confirmLabel: `Save at ${formatBytes(outcome.achievedBytes)}`,
          cancelLabel: 'Keep the original'
        });
        if (!proceed) return;
      }

      const savedTarget = await save(doc, outcome.bytes, `${stem(doc.name)}-compressed.pdf`);
      if (savedTarget && outcome.reachedTarget) {
        notify('success', `Reached ${formatBytes(outcome.achievedBytes)}`, {
          detail: `Target was ${formatBytes(targetBytes)}. ${formatBytes(outcome.originalBytes)} → ${formatBytes(outcome.achievedBytes)} at ${outcome.settings?.dpi} DPI, ${Math.round((outcome.settings?.quality ?? 0) * 100)}% quality.`
        });
      }
      return;
    }

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

    const saved = await save(doc, result.bytes, `${stem(doc.name)}-compressed.pdf`);
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
    const bytes = await composeDocument(
      { pages: doc.pages, annotations: doc.annotations, layerAnnotations: getLayerAnnotations() },
      job
    );
    await save(doc, bytes, `${stem(doc.name)}-cleaned.pdf`);
  },

  sign: async ({ doc, job }) => {
    const hasValues = Object.keys(formValues.value).length > 0;
    if (doc.annotations.length === 0 && !hasValues) {
      notify('warning', 'Nothing has been placed yet.', {
        detail: 'Pick a signature or stamp from the panel, or fill out a form field first.'
      });
      return;
    }

    if (hasValues && formFields.value?.isXfa) {
      // Belt and braces: the overlay never renders fields for an XFA form, so
      // there should be no values — but if any exist, filling them would write to
      // shadow fields the viewer ignores. Refuse before anything is written.
      notify('danger', 'This is an XFA form — nothing was saved.', {
        detail: XFA_MESSAGE,
        timeout: 0
      });
      return;
    }

    // Order matters, and it is the reason SGN-03 lost data. `composeDocument`
    // rebuilds the document with `copyPages`, which does not carry the catalog's
    // /AcroForm; filling the *source* bytes first therefore had its /V values
    // dropped by the compose that followed. Values are written into the final
    // composed document, and `composePages` rebuilds /AcroForm on it so the
    // fields are there to write to. `fillFormFields` now throws if a name is
    // missing, so a regression here fails loudly instead of saving a blank form.
    let bytes = await composeDocument(
      { pages: doc.pages, annotations: doc.annotations, layerAnnotations: getLayerAnnotations() },
      job
    );
    if (hasValues) {
      bytes = await fillFormFields(bytes, formValues.value, true);
    }
    await save(doc, bytes, `${stem(doc.name)}-signed.pdf`);
  },

  normalize: async ({ doc, job }) => {
    const bytes = await currentDocumentBytes(job, true);
    await save(doc, bytes, `${stem(doc.name)}-normalized.pdf`);
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
    // pin() keeps load and close on the same pool instance — two independent
    // lease() calls could land on different instances and leave the close a
    // silent no-op on the wrong one.
    const client = renderWorker.pin();
    try {
      const info = await client.lease(api => api.loadDocument(outcome.bytes));
      source.pageCount = info.pageCount;
      source.pageSizes = info.pageSizes;
      await client.lease(api => api.closeDocument(info.handle));
    } finally {
      client.release();
    }

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
    await save(doc, scrubbed, `${stem(doc.name)}-scrubbed.pdf`);
  },
  compare: async () => {},
  batch: async () => {},
  'md-to-pdf': async () => {}
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
