import { translate } from '../../core/i18n';
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
import { unzipSync } from 'fflate';
import {
  applyRedactions,
  compressDocument,
  compressToTargetSize,
  composeDocument,
  currentDocumentBytes,
  extractDocumentText,
  extractEmbeddedImages,
  fillFormFields,
  flattenDocument,
  pagesToImageArchive,
  protectDocument,
  scrubDocumentMetadata,
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
import { createJobHandle } from '../../core/workers/protocol';
import { findTool, type ToolId } from '../../core/tools';
import { writeSourceBytes } from '../../core/opfs';
import {
  compressMode,
  compressSettings,
  compressTarget,
  compressTargetOutcome,
  lastCompressionResult,
  targetSizeBytes
} from './compress/state';
import {
  annotateFlattenOnExport,
  markdownToPdfSource,
  pdfToImageSettings,
  removeBlanksThreshold,
  signFlattenOnExport,
  splitSettings,
  extractImagesSettings
} from './state';
import { extractSettings } from './extract/state';
import { extractImagesReport, summarize } from './extract-images/state';
import { formFields, formValues } from './sign/state';
import { XFA_MESSAGE } from '../../core/pdf/xfa';
import { pendingRedactions, redactionReport } from './redact/state';
import { protection, protectionActive, protectionIssue } from './protect/state';
import type { ProtectionSettings } from '../../core/pdf/encrypt';
import { scrubSettings } from './metadata/state';
import { ocrReport, ocrSettings } from './ocr/state';
import { runOcr } from '../../core/ocr/runOcr';
import { renderWorker } from '../../core/workers';
import { altTextMap } from './acc/state';

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
async function applyProtection(
  bytes: Uint8Array,
  name: string,
  job?: JobOptions
): Promise<Uint8Array | null> {
  const issue = protectionIssue();
  if (issue) {
    notify('danger', translate('Nothing was saved.'), {
      detail: `${issue} Fix it in the Metadata & privacy panel, or turn password protection off.`,
      timeout: 0
    });
    return null;
  }
  if (!protectionActive()) return bytes;

  if (!name.toLowerCase().endsWith('.pdf')) {
    // A ZIP has no PDF security handler to carry the password, and encrypting the
    // members individually is a different feature than the one that was asked for.
    notify('warning', translate('This export is a ZIP, so no password was applied.'), {
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
    // RED-06 encryption re-writes every object in the file. Passing the job
    // through is what gives it a progress bar and a working Cancel; without it
    // the UI sat at 100% through the slowest part of the export.
    return await protectDocument(bytes, settings, job ?? {});
  } catch (err) {
    notify('danger', translate('Could not password-protect the file — nothing was saved.'), {
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
async function save(
  doc: StaplerDoc,
  bytes: Uint8Array,
  name: string,
  job?: JobOptions
): Promise<boolean> {
  const protectedBytes = await applyProtection(bytes, name, job);
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
        notify('success', translate('Saved {name}', { name: doc.name }), {
          detail: note(formatBytes(bytes.byteLength))
        });
      } else {
        notify('warning', translate('Could not save over the original file.'), {
          detail: 'Nothing was overwritten. Try again to save a new file instead.'
        });
      }
      return saved;
    }
  }

  const saved = await platform.saveFileAs(bytes, name);
  if (saved)
    notify('success', translate('Saved {name}', { name }), {
      detail: note(formatBytes(bytes.byteLength))
    });
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

/**
 * SGN-05 — the finalize step, run on already-composed bytes.
 *
 * Only Sign and Annotate call this, and only when their panel's toggle is on:
 * flattening is destructive to interactivity, so it is never a side effect of
 * some other tool's export. Runs *after* compose because `copyPages` carries
 * `/Annots` through, so flattening earlier would have them copied back in.
 *
 * The counts are reported rather than assumed: a flatten really does cost a
 * link its clickability, and saying so is the difference between a finalize and
 * a silent loss.
 */
async function finalize(
  bytes: Uint8Array,
  flatten: boolean,
  job?: JobOptions
): Promise<Uint8Array> {
  if (!flatten) return bytes;
  const result = await flattenDocument(bytes, job ?? {});
  const parts: string[] = [];
  if (result.fields > 0) parts.push(`${result.fields} form field${result.fields === 1 ? '' : 's'}`);
  if (result.annotationsBaked > 0)
    parts.push(`${result.annotationsBaked} annotation${result.annotationsBaked === 1 ? '' : 's'}`);
  if (parts.length > 0 || result.annotationsDropped > 0) {
    notify('info', translate('Finalized: the export is no longer editable.'), {
      detail:
        (parts.length > 0 ? `Drew ${parts.join(' and ')} into the page. ` : '') +
        (result.annotationsDropped > 0
          ? `${result.annotationsDropped} annotation${result.annotationsDropped === 1 ? '' : 's'} with nothing to draw (links, popups, hidden marks) ${result.annotationsDropped === 1 ? 'was' : 'were'} removed.`
          : '')
    });
  }
  return result.bytes;
}

const HANDLERS: Record<ToolId, CommitHandler> = {
  merge: exportComposed,
  organize: exportComposed,
  insert: exportComposed,
  extract: exportComposed,
  nup: exportComposed,
  crop: exportComposed,
  watermark: exportComposed,
  outline: exportComposed,
  acc: async ({ doc, job }) => {
    const altTexts = Object.fromEntries(altTextMap.value);
    if (Object.keys(altTexts).length === 0) return;

    const bytes = await composeDocument(
      {
        pages: doc.pages,
        annotations: doc.annotations,
        layerAnnotations: getLayerAnnotations()
      },
      job
    );

    const finalBytes = await processWorker.lease(api =>
      api.applyAltText(bytes, altTexts, createJobHandle(job))
    );

    await save(doc, finalBytes, `${stem(doc.name)}-acc.pdf`);
  },

  annotate: async ({ doc, job }) => {
    // ANN-01's own marks are drawn straight into the content stream by
    // `compose`, so this composes exactly as every other tool does; the
    // finalize step is here for the fields and annotations the *source*
    // document brought with it.
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
        bates: getBates(),
        // Same as Sign: Annotate deliberately produces a static page.
        allowXfaLoss: true
      },
      job
    );
    await save(
      doc,
      await finalize(bytes, annotateFlattenOnExport.value, job),
      `${stem(doc.name)}-stapler.pdf`,
      job
    );
  },

  split: async ({ doc, job }) => {
    const settings = splitSettings.value;

    if (settings.mode === 'extract') {
      const selected = doc.pages.filter(p => selectedPageKeys.value.has(p.key));
      if (selected.length === 0) {
        notify('warning', translate('Select the pages to extract first.'), {
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
      notify('warning', translate('This document has no top-level bookmarks.'), {
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
      notify('warning', translate('That produces a single file.'), {
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

    if (settings.outputFormat === 'directory') {
      const dir = await platform.openDirectory();
      if (!dir) return; // User cancelled or unsupported

      const files = unzipSync(result.bytes);
      for (const [fileName, bytes] of Object.entries(files)) {
        await dir.write(fileName, bytes);
      }
      notify(
        'success',
        translate('Saved {count} files to directory', { count: Object.keys(files).length })
      );
    } else {
      await save(doc, result.bytes, `${stem(doc.name)}-split.zip`);
    }
  },

  'remove-blanks': async ({ doc }) => {
    const selected = [...selectedPageKeys.value];
    if (selected.length === 0) {
      notify('warning', translate('Nothing is selected.'), {
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

  /**
   * CNV-06. Deliberately extracts from the *source* bytes rather than
   * `currentDocumentBytes`: composing re-embeds every image through pdf-lib, and
   * an extraction that promises the document's own bytes must not first put them
   * through a rebuild. Page indices are the source pages the workspace shows.
   */
  'extract-img': async ({ doc, job }) => {
    const bytes = await currentDocumentBytes(job);
    const selected = selectedPageKeys.value;
    const indices = doc.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => selected.size === 0 || selected.has(page.key))
      .map(({ index }) => index);

    const result = await extractEmbeddedImages(bytes, indices, job);
    extractImagesReport.value = { docId: doc.id, entries: result.entries };
    const summary = summarize(result.entries);

    if (summary.fileCount === 0) {
      // Saving an empty ZIP would look like a successful export of nothing.
      notify('warning', translate('No images could be extracted.'), {
        detail:
          result.entries.length === 0
            ? 'These pages carry no embedded image XObjects — any pictures you can see are drawn as vectors or text.'
            : summary.reasons.join(' ')
      });
      return;
    }

    if (extractImagesSettings.value.outputFormat === 'directory') {
      const dir = await platform.openDirectory();
      if (dir) {
        const files = unzipSync(result.bytes);
        for (const [fileName, bytes] of Object.entries(files)) {
          await dir.write(fileName, bytes);
        }
        notify(
          'success',
          translate('Saved {count} images to directory', { count: summary.fileCount })
        );
      }
    } else {
      const saved = await save(doc, result.bytes, `${stem(doc.name)}-images.zip`);
      if (saved && summary.skippedCount > 0) {
        notify(
          'warning',
          translate('{count} image(s) were left in the document.', {
            count: summary.skippedCount
          }),
          {
            detail: summary.reasons.join(' ')
          }
        );
      }
    }
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
        notify('info', translate('Already under the target.'), {
          detail: `${doc.name} is ${formatBytes(original.byteLength)}, which is already at or under ${formatBytes(targetBytes)}. Nothing was changed.`
        });
        return;
      }

      const outcome = await compressToTargetSize(original, targetBytes, job);
      if (outcome.plan) {
        lastCompressionResult.value = {
          documentId: doc.id,
          plan: outcome.plan,
          originalBytes: outcome.originalBytes,
          compressedBytes: outcome.achievedBytes,
          keptOriginal: outcome.keptOriginal,
          imageStats: outcome.imageStats
        };
      }
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
        notify('warning', translate('Kept the original file.'), {
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
        notify(
          'success',
          translate('Reached {size}', { size: formatBytes(outcome.achievedBytes) }),
          {
            detail: `Target was ${formatBytes(targetBytes)}. ${formatBytes(outcome.originalBytes)} → ${formatBytes(outcome.achievedBytes)} at ${outcome.settings?.dpi} DPI, ${Math.round((outcome.settings?.quality ?? 0) * 100)}% quality.`
          }
        );
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
    lastCompressionResult.value = {
      documentId: doc.id,
      plan: result.plan,
      originalBytes: result.originalBytes,
      compressedBytes: result.bytes.byteLength,
      keptOriginal: result.keptOriginal,
      imageStats: result.imageStats
    };
    if (result.keptOriginal) {
      notify('warning', translate('Kept the original file.'), {
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
      notify('success', translate('Reduced by {percent}%', { percent }), {
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
      notify('warning', translate('Nothing has been placed yet.'), {
        detail: 'Pick a signature or stamp from the panel, or fill out a form field first.'
      });
      return;
    }

    if (hasValues && formFields.value?.isXfa) {
      // Belt and braces: the overlay never renders fields for an XFA form, so
      // there should be no values — but if any exist, filling them would write to
      // shadow fields the viewer ignores. Refuse before anything is written.
      notify('danger', translate('This is an XFA form — nothing was saved.'), {
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
      {
        pages: doc.pages,
        annotations: doc.annotations,
        layerAnnotations: getLayerAnnotations(),
        // Stamping on top of an XFA form is the workaround the product offers
        // for one, so this path accepts the loss of the dynamic payload that
        // merge and split refuse.
        allowXfaLoss: true
      },
      job
    );
    if (hasValues) {
      // SGN-05 — the fill path's own flatten is left to `finalize`, so the two
      // are one decision. With the toggle off the values stay interactive.
      bytes = await fillFormFields(bytes, formValues.value, false, job);
    }
    await save(
      doc,
      await finalize(bytes, signFlattenOnExport.value, job),
      `${stem(doc.name)}-signed.pdf`,
      job
    );
  },

  normalize: async ({ doc, job }) => {
    const bytes = await currentDocumentBytes(job, true);
    await save(doc, bytes, `${stem(doc.name)}-normalized.pdf`);
  },

  redact: async ({ doc, job }) => {
    const regions = pendingRedactions.value;
    if (regions.length === 0) {
      notify('warning', translate('No regions are marked.'), {
        detail: 'Draw a rectangle on the page, or search for text to mark every occurrence.'
      });
      return;
    }

    const original = await currentDocumentBytes(job);
    const outcome = await applyRedactions(original, regions, job);
    redactionReport.value = outcome;

    // RED-03: saving is blocked when any region fails verification.
    if (!outcome.verified) {
      notify('danger', translate('Redaction could not be verified — nothing was saved.'), {
        detail:
          'The report lists which regions failed and why. Your original document is untouched.',
        timeout: 0
      });
      return;
    }

    const source = {
      id: crypto.randomUUID(),
      name: `${stem(doc.name)}-redacted.pdf`,
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

    await writeSourceBytes(source.id, outcome.bytes);
    registerSource(source);
    replaceWithSource(doc.id, source);
    pendingRedactions.value = [];
    const regionCount = outcome.verdicts.length;
    notify('success', translate('Redaction verified and applied.'), {
      detail:
        `${regionCount} region${regionCount === 1 ? '' : 's'} removed from the page content and ` +
        're-checked in the saved bytes. Export to save.',
      timeout: 0
    });
  },

  metadata: async ({ doc, job }) => {
    const original = await currentDocumentBytes(job);
    const scrubbed = await scrubDocumentMetadata(original, scrubSettings.value, job);
    await save(doc, scrubbed, `${stem(doc.name)}-scrubbed.pdf`, job);
  },
  ocr: async ({ doc, job }) => {
    const settings = ocrSettings.value;

    // Page indices are resolved against the *exported* document, which is what
    // `currentDocumentBytes` produces — the same order the grid shows, so a
    // selection made in the grid means the same pages in the file.
    let pageIndices: number[] | undefined;
    if (settings.selectedPagesOnly) {
      pageIndices = doc.pages
        .map((page, index) => (selectedPageKeys.value.has(page.key) ? index : -1))
        .filter(index => index >= 0);
      if (pageIndices.length === 0) {
        notify('warning', translate('Select the pages to run OCR on first.'), {
          detail: 'Tick pages in the grid, or turn off "Only the pages selected in the grid".'
        });
        return;
      }
    }

    const original = await currentDocumentBytes(job);
    const result = await runOcr(original, doc.pages.length, {
      ...job,
      lang: settings.lang,
      pageIndices
    });

    // `null` is the user declining the model download. That is an answer, not a
    // failure: no toast, no export, nothing written.
    if (!result) return;

    ocrReport.value = {
      wordsAdded: result.wordsAdded,
      wordsSkipped: result.wordsSkipped,
      pages: result.pagesTouched
    };

    if (result.wordsAdded === 0) {
      notify('warning', translate('OCR found no text on those pages.'), {
        detail:
          'Nothing was exported, and your document is unchanged. A blank, very low-resolution, ' +
          'or heavily skewed scan is the usual cause — try Scan cleanup first.'
      });
      return;
    }

    // Deliberately *not* `finalize`. The flatten toggle belongs to Sign and
    // Annotate, whose panels show the control; OCR has no such setting, so
    // routing its export through that path would silently flatten this document
    // if we threaded the panel choice through from somewhere else.
    // OCR adds an invisible text layer and changes nothing else.
    await save(doc, result.bytes, `${stem(doc.name)}-ocr.pdf`);
  },

  // OCR-03. The action bar's primary CTA and the panel's per-format buttons are
  // two routes to one export, so both read the same signals: the page the user
  // selected, the grid they edited, and the format they last chose. Re-extracting
  // page 0 here would have quietly exported a different table from the one on
  // screen.
  'table-extract': async ({ doc, job }) => {
    const { extractPageTextItems } = await import('../../core/operations');
    const { extractTableFromPage, exportTableToCsv, exportTableToTsv, exportTableToXlsx } =
      await import('../../core/ocr/table-extract');
    const { tableExtractPageIndex, tableExtractRows, tableExtractFormat } =
      await import('./ocr/table-extract-state');

    const pageIndex = Math.min(Math.max(0, tableExtractPageIndex.value), doc.pages.length - 1);

    let rows = tableExtractRows.value;
    if (!rows || rows.length === 0) {
      // Nothing previewed yet: extract now rather than exporting an empty file.
      const bytes = await currentDocumentBytes(job);
      const items = await extractPageTextItems(bytes, pageIndex);
      rows = extractTableFromPage(items).rows;
      tableExtractRows.value = rows;
    }

    if (rows.length === 0) {
      notify(
        'warning',
        translate('No structured table data found on page {page}.', { page: pageIndex + 1 }),
        {
          detail:
            'Nothing was exported. Table extraction reads text positions, so a scanned page ' +
            'needs OCR first, and a page with no tabular text has nothing to infer.'
        }
      );
      return;
    }

    const grid = {
      rows,
      headers: rows[0],
      rowCount: rows.length,
      columnCount: rows[0].length
    };
    const base = `${stem(doc.name)}-page${pageIndex + 1}-table`;
    const format = tableExtractFormat.value;

    // Deliberately `platform.saveFileAs`, not the shared `save`: that helper runs
    // the export through `applyProtection`, which encrypts a *PDF*. Running a CSV
    // or XLSX through it would produce an unopenable file.
    const out =
      format === 'xlsx'
        ? { bytes: exportTableToXlsx(grid), name: `${base}.xlsx` }
        : format === 'tsv'
          ? { bytes: new TextEncoder().encode(exportTableToTsv(grid)), name: `${base}.tsv` }
          : { bytes: new TextEncoder().encode(exportTableToCsv(grid)), name: `${base}.csv` };

    const saved = await platform.saveFileAs(out.bytes, out.name);
    if (saved) {
      notify('success', translate('Saved {name}', { name: out.name }), {
        detail: `${grid.rowCount} rows x ${grid.columnCount} columns from page ${pageIndex + 1}`
      });
    }
  },
  'contact-sheet': async ({ doc, job }) => {
    const { exportContactSheet } = await import('../../core/operations');
    const { contactSheetColumns } = await import('./contact-sheet/state');
    const bytes = await currentDocumentBytes(job);
    // The panel's column setting, not a hardcoded 4: the action bar's primary CTA
    // and the panel's own button are two routes to one export and must agree.
    const sheet = await exportContactSheet(doc.id, bytes, contactSheetColumns.value, job);
    await save(doc, sheet, `${stem(doc.name)}-contact-sheet.pdf`);
  },
  compare: async () => {},
  batch: async () => {},
  // CNV-06 — panel only configures the Markdown source (`tools/state.ts`); this is
  // the actual commit, reached the same way every other tool's is: the action
  // bar's single primary CTA (DESIGN-ADAPTATION §4.2). `worksWithoutDocument` on
  // the tool definition means `context.doc` may not correspond to a real open
  // document here — the handler never reads it.
  'md-to-pdf': async () => {
    const markdown = markdownToPdfSource.value;
    if (!markdown.trim()) {
      notify('warning', translate('Nothing to export.'), {
        detail: 'Type or paste some Markdown first.'
      });
      return;
    }
    const { bytes, hadUnsupportedCharacters } = await processWorker.lease(api =>
      api.markdownToPdf(markdown)
    );
    const saved = await platform.saveFileAs(bytes, 'document.pdf');
    if (!saved) return;
    if (hadUnsupportedCharacters) {
      notify('warning', translate('PDF saved, but some characters could not be represented.'), {
        detail:
          'This export uses a fixed set of Latin fonts and replaced unsupported characters (e.g. CJK, Cyrillic, Arabic) with "?". Affected text will need to be checked manually.'
      });
    } else {
      notify('success', translate('PDF saved successfully.'));
    }
  },
  shortcuts: async () => {}
};

export async function commitTool(toolId: ToolId, job: JobOptions): Promise<void> {
  const doc = activeDoc.value;
  const tool = findTool(toolId);
  if (!doc && !tool?.worksWithoutDocument) throw internal('No document is open.');
  const handler = HANDLERS[toolId];
  if (!handler) throw internal(`No commit action is defined for the ${toolId} tool.`);
  // `worksWithoutDocument` tools (md-to-pdf, batch) never read `context.doc`; the
  // cast keeps `CommitContext` simple for the many handlers that do require one.
  await handler({ doc: doc as StaplerDoc, job });
}

/** Re-exported so the extract panel can share the text pipeline. */
export { extractDocumentText, extractSettings, removeBlanksThreshold };
