import { tKey, tPlural, translate } from '../../core/i18n';
/**
 * What the action bar's primary button does, per tool.
 *
 * This was a 100-line `if (isSplitRoute) … else if (isPdfToImgRoute) …` chain inside
 * the action-bar component, mixing worker orchestration, filename policy, and
 * `alert()` reporting. Splitting it out means the action bar only renders, and a new
 * tool adds an entry here instead of another branch.
 */
import { platform } from '../../platform/current';
import { confirmAction, notify, requestExportReview } from '../../core/notify';
import { internal, isCancellation } from '../../core/errors';
import { unzipSync, zipSync } from 'fflate';
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
  pagesToSizedImageArchive,
  protectDocument,
  restrictDocument,
  scrubDocumentMetadata,
  planCompression,
  planSizeSplitBoundaries,
  sanitizeFileStem,
  splitBoundaries,
  splitPointsError,
  splitDocument,
  grayscaleDocument,
  progressBand,
  repairDocument
} from '../../core/operations';
import { grayscaleReport, grayscaleSettings } from './grayscale/state';
import { lastRepair, repairCandidate, repairedName } from './repair/state';
import { processWorker } from '../../core/workers';
import { imagesToPdfBytes } from '../../core/import';
import {
  activeDoc,
  deletePages,
  documentRestrictions,
  refreshBaseline,
  registerSource,
  replaceWithSource,
  selectedPageKeys,
  sources,
  type PageRef,
  type StaplerDoc
} from '../../core/store';
import { alignPages, type PageAlignment } from '../../core/page-alignment';
import {
  formatBytes,
  formatBytesUp,
  formatTargetMiss,
  formatTargetMisses
} from '../components/Feedback';
import type { JobOptions } from '../../core/workers/protocol';
import { createJobHandle } from '../../core/workers/protocol';
import { findTool, type ToolId } from '../../core/tools';
import { readSourceBytes, writeSourceBytes } from '../../core/opfs';
import {
  compressColour,
  compressMode,
  compressSettings,
  compressTarget,
  compressTargetOutcome,
  lastCompressionResult,
  targetSizeBytes
} from './compress/state';
import { applyGrayLever, type CompressColour, type GreyGap } from '../../core/compress-gray';
import {
  annotateFlattenOnExport,
  imagesToPdfSettings,
  markdownToPdfSource,
  pdfToImageSettings,
  removeBlanksThreshold,
  signFlattenOnExport,
  splitSettings,
  extractImagesSettings
} from './state';
import { extractSettings } from './extract/state';
import {
  exactPageOutputs,
  exactSizeOverCap,
  exportedPageSizes,
  pdfExactRequest,
  pdfToImageReport,
  sizedArchiveSuffix
} from './convert/pdf-to-img-state';
import { exactSizeLimitMessage, exactSizeOverLimit } from '../../core/render-limits';
import {
  describeTargetMiss,
  exactOutputFor,
  exactSizeProblem,
  imageSizeRequest,
  imageSizeResult,
  imageSizeSettings
} from './image-size/state';
import { EXACT_SIDE_BOUNDS, matchesExactSize } from '../../core/image-target';
import { orientedHeaderSizeOf } from '../../core/raster-decode';
import { imageOriginalSatisfies, resizeImageFile } from '../../core/image';
import { chooseSmaller } from '../../core/size-guard';
import {
  IMAGE_TARGET_BOUNDS,
  PDF_TARGET_BOUNDS,
  targetKbInRange,
  validateSizeParam,
  type SizeBounds
} from '../../core/deep-link';
import { extractImagesReport, summarize } from './extract-images/state';
import { formFields, formValues, formulas } from './sign/state';
import { applyFormulas } from '../../core/formula';
import { XFA_MESSAGE } from '../../core/pdf/xfa';
import { pendingRedactions, redactionReport } from './redact/state';
import { protection, protectionActive, protectionIssue } from './protect/state';
import { withInheritedRestrictions, type ProtectionSettings } from '../../core/pdf/encrypt';
import { scrubSettings } from './metadata/state';
import { batchIsConfigured, cancelBatch, startBatch } from './batch/runner';
import { ocrReport, ocrSettings } from './ocr/state';
import {
  PDF_TO_WORD_GATE,
  pdfToWordPreview,
  pdfToWordPreviewIsStale
} from './convert/pdf-to-word-state';
import {
  WORD_TO_PDF_GATE,
  wordToPdfPreview,
  wordToPdfPreviewIsStale,
  wordToPdfSource
} from './convert/word-to-pdf-state';
import {
  PDF_TO_EXCEL_GATE,
  pdfToExcelPreview,
  pdfToExcelPreviewIsStale
} from './convert/pdf-to-excel-state';
import {
  EXCEL_TO_PDF_GATE,
  excelToPdfPreview,
  excelToPdfPreviewIsStale,
  excelToPdfSource
} from './convert/excel-to-pdf-state';
import {
  PDF_TO_PPT_GATE,
  pdfToPptPreview,
  pdfToPptPreviewIsStale
} from './convert/pdf-to-ppt-state';
import {
  PPT_TO_PDF_GATE,
  pptToPdfPreview,
  pptToPdfPreviewIsStale,
  pptToPdfSource
} from './convert/ppt-to-pdf-state';
import { runOcr } from '../../core/ocr/runOcr';
import { renderWorker } from '../../core/workers';
import { altTextMap } from './acc/state';
import { fastWebViewExport, loadExportSettings } from './export-settings';

/**
 * IMG-2 / IMG-12 — a target-size field holds something outside its range (the
 * panel already shows why, inline). Nothing runs: running with the last good
 * value, or a clamped one, would use a number the person cannot see.
 */
function notifyExactSizeProblem(problem: 'missing' | 'invalid'): void {
  notify(
    'warning',
    problem === 'missing'
      ? translate('Enter a width or a height.')
      : translate('Enter a whole number of pixels between {min} and {max}.', {
          min: EXACT_SIDE_BOUNDS.min,
          max: EXACT_SIDE_BOUNDS.max
        })
  );
}

function notifyInvalidTarget(bounds: SizeBounds): void {
  notify(
    'warning',
    translate('Enter a size between {min} and {max}.', {
      min: formatBytes(bounds.minBytes),
      max: formatBytes(bounds.maxBytes)
    }),
    {
      detail: translate('Fix the target size in the options panel, then try again.')
    }
  );
}

/**
 * The document differs from the single file it was opened from: other pages,
 * order or rotation, annotations, or a crop on one of its own pages. Panel
 * settings (watermark, header/footer, N-up) and crops on other documents'
 * pages are not edits of this document.
 */
function hasDocumentEdits(doc: StaplerDoc): boolean {
  const first = doc.pages[0];
  if (!first) return true;
  const source = sources.value[first.sourceDocId];
  if (!source || doc.pages.length !== source.pageCount) return true;
  if (doc.annotations.length > 0) return true;
  return doc.pages.some(
    (p, i) =>
      p.sourceDocId !== first.sourceDocId ||
      p.sourceIndex !== i ||
      p.rotation !== 0 ||
      p.key in cropBoxes.value
  );
}

/** Strips the extension so suffixes can be appended without doubling `.pdf`. */
function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'document';
}

/**
 * OPS-19 — the note on Compress's success toast after a grey pass. Never claims
 * the whole file was converted when `gaps` (pages left in colour) says otherwise.
 */
function greyConvertedNote(
  colour: Exclude<CompressColour, 'keep'>,
  gaps: readonly GreyGap[],
  pageCount: number
): string {
  if (gaps.length === 0) {
    return colour === 'bw'
      ? translate('Converted to black and white.')
      : translate('Converted to shades of grey.');
  }
  if (gaps.length >= pageCount) {
    return translate('No page could be converted, so only compression was applied.');
  }
  const pages = gaps.map(g => g.pageIndex + 1).join(', ');
  return colour === 'bw'
    ? translate('Converted to black and white, except pages {pages}.', { pages })
    : translate('Converted to shades of grey, except pages {pages}.', { pages });
}

/** OPS-19 — each page grey left in colour, and why, mirroring the Grayscale panel's report. */
function greyGapDetail(gaps: readonly GreyGap[]): string {
  const lines = gaps.map(gap => {
    const reasons = [...gap.reasons];
    if (gap.undecodableImages > 0) {
      reasons.push(
        tPlural(
          '{count} images use an encoding (JPEG 2000 or JBIG2) that cannot be decoded here',
          gap.undecodableImages
        )
      );
    }
    if (reasons.length === 0) reasons.push(translate('could not be converted directly'));
    return translate('Page {page}: {reason}', {
      page: gap.pageIndex + 1,
      reason: reasons.join('; ')
    });
  });
  return `${lines.join('. ')}.`;
}

/** What `applyProtection` decided, so `save` can describe the file honestly. */
interface ProtectedExport {
  bytes: Uint8Array;
  /** True only when a password is now needed to *open* the file. */
  passwordApplied: boolean;
  /**
   * True when this document's imported restrictions were silently reapplied
   * with no password change requested — the file still opens with no prompt,
   * but it was re-encrypted from whatever security handler it originally
   * carried (RC4/40-128-bit revisions included) into this handler's one fixed
   * algorithm, AES-256/R6 (ISO 32000-2). That is a real, permanent narrowing
   * of which readers can open the file — an old/embedded PDF viewer without
   * R6 support could open the input and can no longer open the output — so
   * `save` discloses it rather than repeating the input's own silence.
   */
  restrictionsPreserved: boolean;
}

/**
 * RED-06 — encrypts what is about to be written, if the user asked for it, and
 * re-applies whatever restrictions the document arrived with either way.
 *
 * The second half is not a feature, it is a leak being closed. Opening a
 * permission-restricted PDF (no user password, printing/copying forbidden by
 * its owner — the common kind) means decrypting it, and pdf-lib drops
 * `/Encrypt` the moment it does; every export built from that document was
 * therefore written back with the restrictions silently gone. `restrictions`
 * is the `/P` the input carried, recovered at import time
 * (`core/pdf/load.ts`), and it is written back verbatim: same flags, still no
 * password to open, exactly as the file behaved before Stapler touched it.
 *
 * Returns `null` when the export must not happen: an encryption failure has to
 * stop the save outright, because writing the unencrypted bytes instead would
 * hand the user a file they believe is protected. Applied here rather than in
 * each handler so every tool's export is covered by one rule, and so nothing
 * forks a second save path.
 */
async function applyProtection(
  bytes: Uint8Array,
  name: string,
  job?: JobOptions,
  restrictions: number | null = null
): Promise<ProtectedExport | null> {
  const issue = protectionIssue();
  if (issue) {
    notify('danger', translate('Nothing was saved.'), {
      detail: translate(
        '{issue} Fix it in the Metadata & privacy panel, or turn password protection off.',
        { issue }
      ),
      timeout: 0
    });
    return null;
  }
  const wantsPassword = protectionActive();
  if (!wantsPassword && restrictions === null) {
    return { bytes, passwordApplied: false, restrictionsPreserved: false };
  }

  if (!name.toLowerCase().endsWith('.pdf')) {
    // A ZIP has no PDF security handler to carry the password, and encrypting the
    // members individually is a different feature than the one that was asked for.
    // The same is true of the imported restrictions: there is no `/Encrypt` on a
    // ZIP, and a rasterised page could not carry one anyway.
    if (wantsPassword) {
      notify('warning', translate('This export is a ZIP, so no password was applied.'), {
        detail: translate('Export a single PDF to password-protect it.'),
        timeout: 0
      });
    }
    return { bytes, passwordApplied: false, restrictionsPreserved: false };
  }

  try {
    if (!wantsPassword) {
      // Restrictions only: the file still opens with no prompt, so nothing is
      // asked of the user up front — but `restrictionsPreserved` still tells
      // `save` to disclose the algorithm change in its success message,
      // rather than staying as silent about it as the input's own restriction
      // was about opening.
      if (restrictions === null) {
        return { bytes, passwordApplied: false, restrictionsPreserved: false };
      }
      return {
        bytes: await restrictDocument(bytes, restrictions, job ?? {}),
        passwordApplied: false,
        restrictionsPreserved: true
      };
    }

    const state = protection.value;
    // The confirmation field and the on/off flag are UI state; only the handler's
    // own settings cross into the worker. Restrictions the document arrived with
    // narrow the user's choices but never widen them: Stapler opened that file
    // with the empty user password, which grants no owner rights, so turning
    // Protect on is not a way to hand printing back.
    const settings: ProtectionSettings = withInheritedRestrictions(
      {
        userPassword: state.userPassword,
        ownerPassword: state.ownerPassword,
        allowPrinting: state.allowPrinting,
        allowCopying: state.allowCopying,
        allowModifying: state.allowModifying
      },
      restrictions
    );
    // RED-06 encryption re-writes every object in the file. Passing the job
    // through is what gives it a progress bar and a working Cancel; without it
    // the UI sat at 100% through the slowest part of the export.
    return {
      bytes: await protectDocument(bytes, settings, job ?? {}),
      passwordApplied: true,
      // Not disclosed separately here: a password requirement is already the
      // headline of `passwordApplied`'s own note, and this is the user's own
      // explicit Protect choice, not a silent narrowing of an already-open file.
      restrictionsPreserved: false
    };
  } catch (err) {
    notify(
      'danger',
      wantsPassword
        ? translate('Could not password-protect the file — nothing was saved.')
        : translate('Could not reapply this document’s restrictions — nothing was saved.'),
      {
        detail: translate('{error} Your document is unchanged.', {
          error: err instanceof Error ? err.message : String(err)
        }),
        timeout: 0
      }
    );
    return null;
  }
}

/**
 * `compress`'s never-grow guarantee (CLAUDE.md), enforced against the bytes
 * actually about to be written rather than the pre-restriction ones: applying
 * a document's imported restrictions (or the user's own Protect settings) adds
 * a handful of bytes for the AES pass, and on a file compressed right down to
 * the wire that can be the difference between under and over the original.
 * `save` checks this immediately after `applyProtection`, before anything
 * reaches disk, and refuses the write rather than silently breaking the
 * guarantee.
 */
export interface GrowthGuard {
  /** The original, pre-compression byte length — never the pre-restriction one. */
  maxBytes: number;
  /**
   * False keeps `maxBytes` as a ceiling for the fast-web-view rewrite only, and
   * lets the file itself exceed it — for Protect, whose growth is the user's own
   * explicit choice. Fast web view is dropped rather than allowed to push a
   * compressed file past the original either way. Default true.
   */
  enforce?: boolean;
  /** English key, marked with `tKey` at construction; translated when shown. */
  title: string;
  /** English key, marked with `tKey` at construction; translated when shown. */
  detail: string;
}

/** What `save` tells a caller about the bytes it is about to write. */
export interface FinalBytesInfo {
  /** True when the written file was rewritten for fast web view (HRD-23). */
  fastWebView: boolean;
}

type OnFinalBytes = (bytes: Uint8Array, info: FinalBytesInfo) => void;

/**
 * `applied`: rewritten for fast web view. `off`: the option is off, or this is
 * not a PDF. `failed`: the rewrite threw, so the ordinary bytes are written.
 * `dropped`: the rewrite would have made a compressed file larger than the
 * original, so the ordinary bytes are written.
 */
type FastWebViewOutcome = 'applied' | 'off' | 'failed' | 'dropped';

/**
 * HRD-23 / DOC-08 — the opt-in fast-web-view rewrite of one finished PDF export.
 *
 * Done here, on the last unencrypted bytes, rather than in each worker save an
 * export happens to run: an export is often several saves in a row (compose,
 * then alt text, flatten, protection), and only the last decides the layout of
 * the written file. Never fatal: if the rewrite fails, the ordinary bytes are
 * written and the success message says fast web view was not applied.
 */
async function forFastWebView(
  bytes: Uint8Array,
  name: string,
  job?: JobOptions
): Promise<{ bytes: Uint8Array; outcome: FastWebViewOutcome }> {
  if (!name.toLowerCase().endsWith('.pdf')) return { bytes, outcome: 'off' };
  await loadExportSettings();
  if (!fastWebViewExport.value) return { bytes, outcome: 'off' };
  try {
    const out = await processWorker.lease(api =>
      api.saveForFastWebView(bytes, createJobHandle(job ?? {}))
    );
    return { bytes: out, outcome: 'applied' };
  } catch (err) {
    if (isCancellation(err)) throw err;
    return { bytes, outcome: 'failed' };
  }
}

/** The size part of a "Saved" detail line, plus a word when fast web view was not applied. */
function fastWebViewNote(size: string, outcome: FastWebViewOutcome): string {
  if (outcome === 'dropped') {
    return translate(
      '{size} · saved without fast web view, which would have made it larger than the original',
      { size }
    );
  }
  if (outcome === 'failed') {
    return translate('{size} · fast web view could not be applied, so it was saved without it', {
      size
    });
  }
  return size;
}

/**
 * The fast-web-view rewrite for the exports that write with
 * `platform.saveFileAs` directly instead of `save` (images-to-pdf, md-to-pdf,
 * repair, the Office-to-PDF conversions). Saves, and says so when fast web
 * view had to be left out. Resolves `platform.saveFileAs`'s answer.
 */
async function saveDirectPdf(bytes: Uint8Array, name: string, job?: JobOptions): Promise<boolean> {
  const fast = await forFastWebView(bytes, name, job);
  const saved = await platform.saveFileAs(fast.bytes, name);
  if (saved && fast.outcome === 'failed') {
    notify(
      'info',
      translate('Fast web view could not be applied, so the file was saved without it.')
    );
  }
  return saved;
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
  job?: JobOptions,
  onFinalBytes?: OnFinalBytes,
  growthGuard?: GrowthGuard,
  // False for any export whose bytes are not a faithful rendering of
  // `doc.pages` as the document itself — a page subset (split), a derived
  // layout (contact sheet), or a non-PDF archive (the `*.zip` tools). Only a
  // "yes, this is what the document now looks like, unchanged in structure"
  // export may advance the review baseline; otherwise the next real export's
  // diff would compare `doc.pages` against itself and report no changes for
  // edits that were never actually written anywhere.
  refreshesBaseline = true
): Promise<boolean> {
  // `documentRestrictions` is read here, at the one place every tool's bytes
  // pass through on their way to disk, rather than threaded through each
  // handler: a tool that forgot to pass it would quietly export an
  // unrestricted copy, which is the failure this whole path exists to prevent.
  const restrictions = documentRestrictions(doc);
  // HRD-23: fast web view is a layout rewrite of the unencrypted bytes, so it
  // runs before protection — whose plain-xref, object-number-order re-save
  // keeps the first-page-first numbering it produces.
  const fast = await forFastWebView(bytes, name, job);
  let fastWebView = fast.outcome;
  let toProtect = fast.bytes;
  // The fast-web-view ceiling is checked on the *unprotected* bytes, before
  // anything is encrypted: what fast web view is answerable for is its own
  // share of the growth (no object streams), not the AES pass that follows.
  // Checking after encryption used to blame fast web view for Protect's
  // bytes, and then ran a second full encryption pass over the plain bytes to
  // find out — even with `enforce: false`, where the result was never going
  // to be refused anyway.
  if (
    fastWebView === 'applied' &&
    growthGuard &&
    fast.bytes.byteLength > growthGuard.maxBytes &&
    fast.bytes.byteLength > bytes.byteLength
  ) {
    toProtect = bytes;
    fastWebView = 'dropped';
  }
  // Encrypted once. No second pass over the plain bytes if this comes out
  // over the ceiling: the encryption re-save (`protectDocument` /
  // `restrictDocument`) writes a plain xref without object streams whatever
  // it is given, so the plain bytes encrypt to the same size give or take a
  // few bytes — the growth past this point is the encryption's own, and it is
  // either the user's choice (Protect, `enforce: false`) or refused below.
  const result = await applyProtection(toProtect, name, job, restrictions);
  if (!result) return false;
  const protectedResult = result;
  bytes = protectedResult.bytes;
  if (growthGuard && growthGuard.enforce !== false && bytes.byteLength > growthGuard.maxBytes) {
    notify('warning', translate(growthGuard.title), {
      detail: translate(growthGuard.detail),
      timeout: 0
    });
    return false;
  }
  onFinalBytes?.(bytes, { fastWebView: fastWebView === 'applied' });
  const note = (bytesLabel: string) => {
    const size = fastWebViewNote(bytesLabel, fastWebView);
    if (protectedResult.passwordApplied) {
      return translate('{size} · password required to open', { size });
    }
    // No password either before or after, but the restrictions this document
    // arrived with were carried through by re-encrypting under this handler's
    // one fixed algorithm (AES-256/R6) — worth a word, since a reader that
    // opened the input under an older/weaker handler is not guaranteed to
    // open this output.
    if (protectedResult.restrictionsPreserved) {
      return translate(
        "{size} · this document's restrictions were preserved (now AES-256-encrypted; needs a reader from the last decade or so)",
        { size }
      );
    }
    return size;
  };

  // Same test as the baseline refresh below, and for the same reason: "save
  // over original" replaces the file the user opened with exactly these
  // bytes. Offering that for a page subset, a contact sheet, or a ZIP would
  // let "Save over original" silently overwrite the user's real document with
  // something that is not it — the file-destruction case the never-corrupt
  // invariant exists to prevent, not merely a stale review.
  if (refreshesBaseline && doc.sourceHandle?.writable) {
    announceWaiting(job, translate('Waiting for confirmation…'));
    const overwrite = await confirmAction({
      title: translate('Save changes to {name}?', { name: doc.name }),
      body: translate('Save over the original file, or keep it and save a new file instead.'),
      confirmLabel: translate('Save over original'),
      cancelLabel: translate('Save as new file')
    });
    if (overwrite) {
      const saved = await platform.saveOver(doc.sourceHandle.fileId, bytes);
      if (saved) {
        refreshBaseline(doc.id, doc.pages, doc.annotations);
        notify('success', translate('Saved {name}', { name: doc.name }), {
          detail: note(formatBytes(bytes.byteLength))
        });
      } else {
        notify('warning', translate('Could not save over the original file.'), {
          detail: translate('Nothing was overwritten. Try again to save a new file instead.')
        });
      }
      return saved;
    }
  }

  const saved = await platform.saveFileAs(bytes, name);
  if (saved) {
    if (refreshesBaseline) refreshBaseline(doc.id, doc.pages, doc.annotations);
    notify('success', translate('Saved {name}', { name }), {
      detail: note(formatBytes(bytes.byteLength))
    });
  }
  return saved;
}

/**
 * The last `onProgress` report from whatever ran just before (composing the
 * review's bytes, a compression search, a re-encode plan — "Writing file ·
 * 95%") otherwise sits frozen on the action bar for as long as the ensuing
 * modal/dialog is open — a job that's actually paused, waiting on the user,
 * looking exactly like one still grinding away. There's nothing left to
 * report a real fraction of, so this clears it to an indeterminate,
 * honestly-labelled wait instead of leaving stale progress up. Used both
 * before the review modal and before every plain confirm dialog a commit
 * handler shows mid-job (save-over-original, compression trade-offs).
 */
function announceWaiting(job: JobOptions | undefined, label = translate('Reviewing…')): void {
  job?.onProgress?.(null, label);
}

/**
 * UX-04 — shows `ExportReviewModal` before anything is written, then defers
 * to `save()` unchanged. `originalBytes: null` skips the diff and shows the
 * result alone — for a tool with no single "before" PDF to compare against
 * (images-to-pdf, contact-sheet) or where the output is a page *subset*, so a
 * page-index diff against the original would silently compare unrelated pages
 * (split's single-file branch).
 */
async function reviewAndSave(
  doc: StaplerDoc,
  originalBytes: Uint8Array | null,
  bytes: Uint8Array,
  name: string,
  job?: JobOptions,
  onFinalBytes?: OnFinalBytes,
  alignment?: PageAlignment,
  // See `save()` — false when `bytes` is a page subset or a different layout
  // entirely (split's single-file branch, the contact sheet), so it must not
  // be mistaken for "the document, saved" once it reaches disk.
  refreshesBaseline = true
): Promise<boolean> {
  announceWaiting(job);
  const proceed = await requestExportReview({
    kind: 'single',
    originalBytes,
    resultBytes: bytes,
    fileName: name,
    alignment
  });
  if (!proceed) return false;
  return save(doc, bytes, name, job, onFinalBytes, undefined, refreshesBaseline);
}

/**
 * `applyProtection`'s restriction pass only ever sees one `.pdf` at a time —
 * `save()` bails out on a `.zip` name because a ZIP itself has no security
 * handler to carry anything. Split is the one tool that turns a single
 * restricted document into several real PDFs, each of which can and should
 * carry the input's `/P` on its own, so that path re-zips through here instead
 * of going straight from `splitDocument`'s output to `save()`/a directory
 * write. Not called for `pdf-to-img`/`extract-img`: their archive members are
 * rasters, which have no PDF permissions to lose in the first place.
 */
async function restrictZipMembers(
  bytes: Uint8Array,
  restrictions: number,
  job?: JobOptions
): Promise<Uint8Array> {
  const files = unzipSync(bytes);
  const restricted: Record<string, Uint8Array> = {};
  for (const [name, member] of Object.entries(files)) {
    restricted[name] = name.toLowerCase().endsWith('.pdf')
      ? await restrictDocument(member, restrictions, job ?? {})
      : member;
  }
  return zipSync(restricted);
}

/**
 * The zip equivalent — each archive member previewed on its own rather than
 * diffed against the original, since a split chunk or an extracted image
 * never lines up 1:1 with a single original page.
 */
async function reviewAndSaveZip(
  doc: StaplerDoc,
  bytes: Uint8Array,
  name: string,
  job?: JobOptions
): Promise<boolean> {
  announceWaiting(job);
  const proceed = await requestExportReview({
    kind: 'zip',
    originalBytes: null,
    resultBytes: bytes,
    fileName: name
  });
  if (!proceed) return false;
  // A ZIP is never `doc.pages` written out as the document — it's rasters or
  // split members — so it must not advance the review baseline or trigger
  // "save over original" (see `save()`).
  return save(doc, bytes, name, job, undefined, undefined, false);
}

/** Same zip review, for the two directory-write branches that never call `save()`. */
async function reviewZipOnly(bytes: Uint8Array, name: string, job?: JobOptions): Promise<boolean> {
  announceWaiting(job);
  return requestExportReview({
    kind: 'zip',
    originalBytes: null,
    resultBytes: bytes,
    fileName: name
  });
}

/**
 * The single-file review for tools that call `platform.saveFileAs` directly
 * rather than the doc-based `save()` — `worksWithoutDocument` tools building a
 * PDF from scratch (images-to-pdf, md-to-pdf) have no `StaplerDoc`/original
 * file to offer a save-over-original prompt for.
 */
async function reviewOnly(bytes: Uint8Array, name: string, job?: JobOptions): Promise<boolean> {
  announceWaiting(job);
  return requestExportReview({
    kind: 'single',
    originalBytes: null,
    resultBytes: bytes,
    fileName: name
  });
}

export interface CommitContext {
  doc: StaplerDoc;
  job: JobOptions;
}

type CommitHandler = (context: CommitContext) => Promise<void>;

import { cropBoxes } from './crop/state';
import {
  batesSettings,
  watermarkSettings,
  headerFooterSettings,
  barcodeStampSettings
} from './watermark/state';
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

/** OPS-18 — the QR/barcode stamp, or nothing when disabled or empty. */
function getBarcodeStamp() {
  const settings = barcodeStampSettings.value;
  if (!settings.enabled || !settings.text.trim()) return undefined;
  return {
    kind: settings.kind,
    text: settings.text,
    position: settings.position,
    scale: settings.scale
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
function getOutline(doc: StaplerDoc, pages: PageRef[]) {
  if (outlineDocId.value !== doc.id || !outlineEdited.value) return undefined;
  return entriesToNodes(
    outlineTree.value,
    pages.map(page => page.key)
  );
}

/** OPS-12 — the loaded outline's top-level entries, as split boundaries and names. */
function topLevelBookmarkSlices(doc: StaplerDoc, pages: PageRef[]) {
  const tree = outlineDocId.value === doc.id ? outlineTree.value : [];
  return topLevelSlices(
    tree,
    pages.map(page => page.key)
  );
}

/**
 * `alignPages`'s per-page rotated/moved/new/removed metadata is built one
 * entry per *original* page — meaningless once N-up has collapsed 2 or 4
 * original pages onto one output sheet, since the review then reads that
 * metadata at a *sheet* index and hands the wrong baseline page to it. Only
 * relevant to a handler whose own compose actually passes `nup` through
 * (annotate, normalize, metadata, ocr — via `currentDocumentBytes`, which
 * always does); a handler that never composes with N-up has nothing to guard
 * against. `undefined` here is exactly what the contact sheet and N-up's own
 * export already pass for the same "different page layout entirely" reason —
 * no alignment, rather than a wrong one.
 */
function alignmentUnlessComposed(doc: StaplerDoc): PageAlignment | undefined {
  return nupSettings.value ? undefined : alignPages(doc.baseline, doc.pages);
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
      outline: getOutline(doc, doc.pages),
      bates: getBates(),
      barcodeStamp: getBarcodeStamp()
    },
    job
  );

  // N-up collapses 2 or 4 *original* pages onto each output sheet — the same
  // "a different page layout entirely" case the contact sheet is (UX-04): a
  // page-index diff, and `alignment` (one entry per *original* page, not per
  // sheet), would either compare unrelated pages or — reading
  // `alignment.entries[sheetIndex]` — hand the wrong baseline page to a sheet
  // that never corresponded to it 1:1. After-only review instead.
  if (nupSettings.value) {
    await reviewAndSave(doc, null, bytes, `${stem(doc.name)}-stapler.pdf`);
    return;
  }

  // The "before" is a bare compose of `doc.baseline` — page content only, no
  // crop/watermark/header-footer/outline/bates/barcode, so the review diff
  // isolates what this export step adds on top *and* shows whatever Organize
  // itself did (rotate/reorder/delete/duplicate) since the baseline was last
  // anchored, via `alignment` below.
  const original = await composeDocument(
    { pages: doc.baseline, annotations: doc.annotations },
    job
  );
  const alignment = alignPages(doc.baseline, doc.pages);
  await reviewAndSave(
    doc,
    original,
    bytes,
    `${stem(doc.name)}-stapler.pdf`,
    undefined,
    undefined,
    alignment
  );
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
  const fields = result.fields > 0 ? tPlural('{count} form fields', result.fields) : null;
  const annotations =
    result.annotationsBaked > 0 ? tPlural('{count} annotations', result.annotationsBaked) : null;
  const drawn = fields ?? annotations;
  const drew =
    fields && annotations
      ? translate('Drew {fields} and {annotations} into the page.', { fields, annotations })
      : drawn
        ? translate('Drew {items} into the page.', { items: drawn })
        : null;
  const dropped =
    result.annotationsDropped > 0
      ? tPlural(
          '{count} annotations with nothing to draw (links, popups, hidden marks) were removed.',
          result.annotationsDropped
        )
      : null;
  if (drew || dropped) {
    notify('info', translate('Finalized: the export is no longer editable.'), {
      detail: [drew, dropped].filter(Boolean).join(' ')
    });
  }
  return result.bytes;
}

/**
 * CNV-08..13 — the one save path the six Office conversions share.
 *
 * All six do exactly the same four things, and each of the four is a place to
 * get it wrong once per tool: refuse when the preview is missing or stale (the
 * gate on the button is a courtesy; *this* is the guarantee), name the file,
 * run a PDF output — and only a PDF output — through RED-06's protection step,
 * and report what was written. Written six times, a fix to any of them was five
 * more edits nobody was reminded to make.
 *
 * What stays per-tool is only what genuinely differs: the preview, its
 * staleness rule, the sentence shown when the gate is closed, the file name, and
 * the notification's detail line.
 *
 * Deliberately never converts. The preview is mandatory (PLAN §5.5), and the
 * only way to guarantee that what was reviewed is what gets written is to save
 * the very bytes the preview was rendered from — re-running the conversion here
 * would reopen the gap between the two.
 */
async function commitConvertedPreview<P extends { bytes: Uint8Array }>(input: {
  /** The previewed result, or nothing when the panel has not produced one. */
  preview: P | null;
  /** True when the preview no longer describes its input — see the state modules. */
  stale: boolean;
  /** The sentence that explains a closed gate, shown as a warning that does not time out. */
  gate: string;
  /** The output file name. Read only once there is something to save. */
  name: (preview: P) => string;
  /** The notification's detail line, from the bytes actually written. */
  detail: (preview: P, bytes: Uint8Array) => string;
  /**
   * Present only when the output is a **PDF**: RED-06's password applies to
   * every PDF this app writes, and skipping it for these three would be a
   * silent exception to that. Absent for `.docx`/`.xlsx`/`.pptx`, which
   * `applyProtection` would turn into an unopenable file — the same reason
   * OCR-03's CSV/XLSX export takes the unprotected path.
   */
  protectAsPdf?: JobOptions;
}): Promise<void> {
  const preview = input.preview;
  if (!preview || input.stale) {
    notify('warning', translate('Nothing was saved.'), {
      detail: translate(input.gate),
      timeout: 0
    });
    return;
  }

  const name = input.name(preview);
  let bytes = preview.bytes;
  let fastWebView: FastWebViewOutcome = 'off';
  if (input.protectAsPdf) {
    // HRD-23: a layout-only rewrite (numbering and xref), not a re-conversion,
    // so the saved pages are still exactly the ones the preview showed.
    const fast = await forFastWebView(bytes, name, input.protectAsPdf);
    bytes = fast.bytes;
    fastWebView = fast.outcome;
    // No `restrictions` argument: these three convert *into* PDF from a Word,
    // Excel or PowerPoint file, so there is no imported `/Encrypt` to carry —
    // and the other three write `.docx`/`.xlsx`/`.pptx`, which take no PDF
    // security handler at all.
    const result = await applyProtection(bytes, name, input.protectAsPdf);
    if (!result) return;
    bytes = result.bytes;
  }

  const saved = await platform.saveFileAs(bytes, name);
  if (!saved) return;
  notify('success', translate('Saved {name}', { name }), { detail: input.detail(preview, bytes) });
  if (fastWebView === 'failed') {
    notify(
      'info',
      translate('Fast web view could not be applied, so the file was saved without it.')
    );
  }
}

/**
 * The parts of a conversion's "Saved" detail line, joined with " · ". Each part
 * is a complete translated phrase; the separator is punctuation, not prose.
 */
function detailLine(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/** "3 items could not be converted — see the panel", or nothing at all. */
function unconvertedNote(items: readonly unknown[], kind: 'failed' | 'omitted'): string | null {
  if (items.length === 0) return null;
  return kind === 'failed'
    ? tPlural('{count} items could not be converted — see the panel', items.length)
    : tPlural('{count} items were left out — see the panel', items.length);
}

const HANDLERS: Record<ToolId, CommitHandler> = {
  // `worksWithoutDocument` (merge now builds a document from scratch, same as
  // images-to-pdf) means `context.doc` may not correspond to a real open
  // document — read the live signal instead of trusting the non-null cast the
  // rest of the handlers rely on.
  merge: async ({ job }) => {
    const doc = activeDoc.value;
    if (!doc) {
      notify('warning', translate('Nothing to export.'), {
        detail: translate('Add at least one PDF or image first.')
      });
      return;
    }
    await exportComposed({ doc, job });
  },
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

    const original = await composeDocument(
      { pages: doc.baseline, annotations: doc.annotations },
      job
    );
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

    // Alt text itself carries no visible mark — the review's diff isolates to
    // whatever Organize/Annotate did since the baseline (via `alignment`),
    // which is worth seeing here too rather than only in those tools' own
    // reviews.
    const alignment = alignPages(doc.baseline, doc.pages);
    await reviewAndSave(
      doc,
      original,
      finalBytes,
      `${stem(doc.name)}-acc.pdf`,
      undefined,
      undefined,
      alignment
    );
  },

  annotate: async ({ doc, job }) => {
    // ANN-01's own marks are drawn straight into the content stream by
    // `compose`, so this composes exactly as every other tool does; the
    // finalize step is here for the fields and annotations the *source*
    // document brought with it.
    // "Before" omits only `layerAnnotations` — everything else here
    // (crop/watermark/etc.) is already reflected on the canvas the same way
    // as any other tool, so the review's diff isolates the marks this tool
    // itself adds, plus whatever Organize did since the baseline (`alignment`).
    const original = await composeDocument(
      {
        pages: doc.baseline,
        annotations: doc.annotations,
        cropBoxes: cropBoxes.value,
        watermark: watermarkSettings.value,
        headerFooter: headerFooterSettings.value,
        nup: nupSettings.value,
        outline: getOutline(doc, doc.baseline),
        bates: getBates(),
        barcodeStamp: getBarcodeStamp(),
        allowXfaLoss: true
      },
      job
    );
    const bytes = await composeDocument(
      {
        pages: doc.pages,
        annotations: doc.annotations,
        cropBoxes: cropBoxes.value,
        watermark: watermarkSettings.value,
        headerFooter: headerFooterSettings.value,
        nup: nupSettings.value,
        layerAnnotations: getLayerAnnotations(),
        outline: getOutline(doc, doc.pages),
        bates: getBates(),
        barcodeStamp: getBarcodeStamp(),
        // Same as Sign: Annotate deliberately produces a static page.
        allowXfaLoss: true
      },
      job
    );
    const alignment = alignmentUnlessComposed(doc);
    await reviewAndSave(
      doc,
      original,
      await finalize(bytes, annotateFlattenOnExport.value, job),
      `${stem(doc.name)}-stapler.pdf`,
      job,
      undefined,
      alignment
    );
  },

  split: async ({ doc, job }) => {
    const settings = splitSettings.value;

    // X-8: refuse rather than cut at pages the user did not ask for.
    if (settings.mode === 'custom') {
      const invalid = splitPointsError(settings.customBoundaries);
      if (invalid) {
        notify('warning', invalid);
        return;
      }
    }

    if (settings.mode === 'extract') {
      const selected = doc.pages.filter(p => selectedPageKeys.value.has(p.key));
      if (selected.length === 0) {
        notify('warning', translate('Select the pages to extract first.'), {
          detail: translate('Click pages in the grid, or press Space to select the focused page.')
        });
        return;
      }
      const bytes = await composeDocument(
        { pages: selected, annotations: doc.annotations, layerAnnotations: getLayerAnnotations() },
        job
      );
      // UX-04: no diff against the original — a page subset, the same reason
      // the non-extract single-file branch below skips one too — but still a
      // real review, not a silent write straight to disk: `split` is in
      // `TOOLS_WITH_EXPORT_REVIEW`, and extract mode is the one branch of it
      // that used to bypass the dialog the action bar had already promised.
      // Not `doc.pages` — must not be mistaken for "the document, saved" (see
      // `save()`), hence `refreshesBaseline: false`.
      await reviewAndSave(
        doc,
        null,
        bytes,
        `${stem(doc.name)}-extract.pdf`,
        undefined,
        undefined,
        undefined,
        false
      );
      return;
    }

    // OPS-12 — the boundaries and the filenames both come from the outline.
    const bookmarks = settings.mode === 'bookmarks' ? topLevelBookmarkSlices(doc, doc.pages) : null;
    if (settings.mode === 'bookmarks' && (!bookmarks || bookmarks.length === 0)) {
      notify('warning', translate('This document has no top-level bookmarks.'), {
        detail: translate('Add them in the Bookmarks tool, or choose another split mode.')
      });
      return;
    }

    // OPS-15 — the boundaries depend on each page range's real composed size,
    // which is only known after composing, so this mode gets its own async
    // planning step instead of `splitBoundaries`' synchronous page-count-only ones.
    let oversizedPages: { pageIndex: number; bytes: number }[] = [];
    const boundaries =
      settings.mode === 'size'
        ? await (async () => {
            const plan = await planSizeSplitBoundaries(
              {
                pages: doc.pages,
                annotations: doc.annotations,
                layerAnnotations: getLayerAnnotations(),
                bates: getBates(),
                barcodeStamp: getBarcodeStamp()
              },
              // Decimal, like every size Stapler shows: "5000 KB" means
              // 5,000,000 bytes, the way upload portals count it (IMG-4).
              settings.targetSizeKb * 1000,
              job
            );
            oversizedPages = plan.oversized;
            return plan.boundaries;
          })()
        : splitBoundaries(settings.mode, doc.pages.length, {
            every: settings.everyN,
            custom: settings.customBoundaries,
            bookmarkStarts: bookmarks?.map(bookmark => bookmark.pageIndex)
          });
    if (boundaries.length === 0 && !bookmarks) {
      if (settings.mode === 'size') {
        notify('info', translate('The whole document already fits under the target size.'), {
          detail: translate('It will be exported as a single file.')
        });
      } else {
        notify('warning', translate('That produces a single file.'), {
          detail: translate('Choose split points inside the document, or use Extract instead.')
        });
        return;
      }
    }
    if (oversizedPages.length > 0) {
      // A single page's own composed size exceeded the target — there is no
      // further cut that could shrink it, so the target was not actually
      // honoured for these files. Say so rather than silently handing back a
      // larger file than the user asked for.
      notify(
        'warning',
        tPlural('{count} pages exceed the target size on their own.', oversizedPages.length),
        {
          detail: tPlural(
            'Pages {pages} could not be shrunk further by splitting alone.',
            oversizedPages.length,
            {
              pages: oversizedPages
                .map(p => `${p.pageIndex + 1} (${formatBytesUp(p.bytes)})`)
                .join(', ')
            }
          ),
          timeout: 0
        }
      );
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
        barcodeStamp: getBarcodeStamp(),
        boundaries,
        baseName: stem(doc.name),
        fileNames
      },
      job
    );

    const restrictions = documentRestrictions(doc);

    if (!result.isZip) {
      // A single bookmark means a single file, which is still a valid answer — it
      // just keeps the bookmark's name rather than arriving in a one-entry ZIP.
      // UX-04: no diff against the original — this file is a page *subset*, so a
      // page-index comparison would silently line up unrelated pages.
      // `.pdf` name, so `save()`'s own `applyProtection` re-applies `restrictions` —
      // no need to do it here too.
      const single = fileNames?.[0] ?? `${stem(doc.name)}-part-01`;
      // A page subset, not `doc.pages` — must not be mistaken for "the
      // document, saved" (see `save()`).
      await reviewAndSave(
        doc,
        null,
        result.bytes,
        `${single}.pdf`,
        undefined,
        undefined,
        undefined,
        false
      );
      return;
    }

    const zipBytes =
      restrictions === null
        ? result.bytes
        : await restrictZipMembers(result.bytes, restrictions, job);

    if (settings.outputFormat === 'directory') {
      if (!(await reviewZipOnly(zipBytes, translate('the split files'), job))) return;
      const dir = await platform.openDirectory();
      if (!dir) return; // User cancelled or unsupported

      const files = unzipSync(zipBytes);
      for (const [fileName, bytes] of Object.entries(files)) {
        await dir.write(fileName, bytes);
      }
      notify(
        'success',
        translate('Saved {count} files to directory', { count: Object.keys(files).length })
      );
    } else {
      await reviewAndSaveZip(doc, zipBytes, `${stem(doc.name)}-split.zip`);
    }
  },

  'remove-blanks': async ({ doc }) => {
    const selected = [...selectedPageKeys.value];
    if (selected.length === 0) {
      notify('warning', translate('Nothing is selected.'), {
        detail: translate('Run Detect blank pages, review what it found, then confirm.')
      });
      return;
    }
    // OPS-05: nothing is removed without explicit confirmation.
    const confirmed = await confirmAction({
      title: tPlural('Delete {count} pages?', selected.length),
      body: translate(
        'They are removed from the workspace only. Undo with ⌘Z; the file on disk is untouched until you export.'
      ),
      confirmLabel: translate('Delete pages'),
      tone: 'danger'
    });
    if (confirmed) deletePages(doc.id, selected);
  },

  'pdf-to-img': async ({ doc, job }) => {
    const settings = pdfToImageSettings.value;
    // GAP-5 — a pixel limit or a size target goes through the measured
    // per-image search; plain resolution exports keep the original path.
    const targetMode = settings.sizeMode === 'target';
    // Same rule as IMG-2: never run with a size the field is not showing —
    // checked before composing, so a refusal costs nothing.
    if (targetMode && !targetKbInRange(settings.targetKb)) {
      notifyInvalidTarget(IMAGE_TARGET_BOUNDS);
      return;
    }
    // CNV-14: the same for an exact width × height, and for one that some
    // exported page would take past what a render may allocate — all known
    // from the page sizes, so refused before anything is composed.
    const exactProblem = exactSizeProblem(settings.exact);
    if (exactProblem) {
      notifyExactSizeProblem(exactProblem);
      return;
    }
    const exact = pdfExactRequest(settings);
    if (exact) {
      const tooBig = exactSizeOverCap(
        exactPageOutputs(exportedPageSizes(doc, sources.value, selectedPageKeys.value), exact)
      );
      if (tooBig) {
        notify('warning', exactSizeLimitMessage(tooBig), {
          detail: translate('Page {page}', { page: tooBig.pageIndex + 1 })
        });
        return;
      }
    }
    const bytes = await currentDocumentBytes(job);
    const selected = selectedPageKeys.value;
    const indices = doc.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => selected.size === 0 || selected.has(page.key))
      .map(({ index }) => index);

    if (!targetMode && !exact && settings.maxDimension === null) {
      const archive = await pagesToImageArchive(bytes, indices, settings.format, settings.dpi, job);
      await reviewAndSaveZip(doc, archive, `${stem(doc.name)}-${settings.dpi}dpi.zip`);
      return;
    }

    const targetBytes = targetMode ? Math.round(settings.targetKb * 1000) : null;
    const { archive, pages } = await pagesToSizedImageArchive(
      bytes,
      indices,
      targetMode ? 'jpeg' : settings.format,
      settings.dpi,
      exact
        ? { targetBytes, maxDimension: null, width: exact.width, height: exact.height }
        : { targetBytes, maxDimension: settings.maxDimension },
      job
    );
    pdfToImageReport.value = { docId: doc.id, targetBytes, pages };
    const missed = pages.filter(page => !page.reached);
    const suffix = sizedArchiveSuffix(settings);
    const saved = await reviewAndSaveZip(doc, archive, `${stem(doc.name)}-${suffix}.zip`);
    if (saved && missed.length > 0 && targetBytes !== null) {
      // Never a silent miss: name the pages and their measured sizes.
      // Rounded so that no miss reads as the target itself (IMG-3).
      const shown = formatTargetMisses(
        targetBytes,
        missed.map(page => page.bytes)
      );
      const missedPages = missed
        .map((page, index) =>
          translate('page {page} ({size})', {
            page: page.pageIndex + 1,
            size: shown.achieved[index]
          })
        )
        .join(', ');
      notify(
        'warning',
        tPlural('{count} images are over {size}.', missed.length, {
          size: shown.target
        }),
        {
          // At an exact size only quality moved (CNV-14), so resolution is
          // not a lever to suggest.
          detail: exact
            ? translate(
                'Each was saved at the lowest quality Stapler could use at the pixel size you set: {pages}. Choose a smaller pixel size, or raise the target.',
                { pages: missedPages }
              )
            : translate(
                'Each was saved at the smallest size Stapler could make: {pages}. Lower the starting resolution or the page count, or raise the target.',
                { pages: missedPages }
              ),
          timeout: 0
        }
      );
    }
  },

  /**
   * GAP-5 — one image to a JPEG at or under a size and/or within a pixel box.
   * The search runs in the image worker and every number it reports is
   * measured on the bytes about to be written. A miss is never saved silently:
   * the smallest file found is offered, with its size, for the person to accept.
   */
  'image-to-size': async ({ job }) => {
    const settings = imageSizeSettings.value;
    const file = settings.file;
    if (!file) {
      notify('warning', translate('Choose an image first.'), {
        detail: translate('Pick a JPEG, PNG, WebP, GIF, HEIC or TIFF file in the options panel.')
      });
      return;
    }
    // IMG-2: the run uses exactly the value on screen, so an unusable one is
    // refused here rather than replaced by some other number.
    if (settings.useTarget && !validateSizeParam(settings.target, IMAGE_TARGET_BOUNDS).ok) {
      notifyInvalidTarget(IMAGE_TARGET_BOUNDS);
      return;
    }
    // CNV-14: the same rule for an exact width × height.
    const exactProblem = exactSizeProblem(settings.exact);
    if (exactProblem) {
      notifyExactSizeProblem(exactProblem);
      return;
    }
    const request = imageSizeRequest(settings);
    // CNV-14: an exact size no canvas can hold is refused before the image is
    // decoded. Unlocked, both sides are known; locked, the following side is
    // worked out from the size the header declares (EXIF-oriented). A HEIC or
    // TIFF, whose size only the worker knows, is checked there instead.
    if (request.width !== null || request.height !== null) {
      const header =
        request.width === null || request.height === null ? await orientedHeaderSizeOf(file) : null;
      const output = exactOutputFor(request, header);
      if (output && exactSizeOverLimit(output)) {
        notify('warning', exactSizeLimitMessage(output));
        return;
      }
    }
    const resized = await resizeImageFile(file, request, job);

    // IMG-1 — an original that already meets every limit is better left
    // alone whenever the re-encode is no smaller: re-encoding can only lose
    // quality, and a PNG or WebP re-saved as JPEG easily grows. "Meets every
    // limit" includes format and orientation (`imageOriginalSatisfies`), so a
    // HEIC or a sideways JPEG is still converted.
    const original = new Uint8Array(await file.arrayBuffer());
    const choice = chooseSmaller({
      originalBytes: original.byteLength,
      resultBytes: resized.bytes.byteLength,
      // An exact size the original does not have (CNV-14) must be converted.
      originalSatisfies:
        matchesExactSize({ width: resized.sourceWidth, height: resized.sourceHeight }, request) &&
        imageOriginalSatisfies(original, resized, request)
    });
    const keepOriginal = choice === 'original';

    const bytes = keepOriginal ? original : resized.bytes;
    // Every claim below is measured on `bytes`, the file about to be written.
    const reached = request.targetBytes === null || bytes.byteLength <= request.targetBytes;
    imageSizeResult.value = {
      source: file,
      bytes,
      width: keepOriginal ? resized.sourceWidth : resized.width,
      height: keepOriginal ? resized.sourceHeight : resized.height,
      sourceWidth: resized.sourceWidth,
      sourceHeight: resized.sourceHeight,
      quality: keepOriginal ? null : resized.quality,
      targetBytes: request.targetBytes,
      reached,
      attempts: resized.attempts,
      sourcePages: resized.sourcePages,
      sourceFrames: keepOriginal ? 1 : resized.sourceFrames,
      keptOriginal: keepOriginal
    };

    if (!reached && request.targetBytes !== null) {
      const miss = describeTargetMiss(request.targetBytes, bytes.byteLength);
      announceWaiting(job, translate('Waiting for confirmation…'));
      const proceed = await confirmAction({
        title: translate('Could not reach {size}', { size: miss.target }),
        body: translate(
          'The smallest Stapler could make is {size} — {over} over your {target} target — at {width}×{height} px, measured after {attempts}. Save it anyway?',
          {
            size: miss.achieved,
            over: miss.over,
            target: miss.target,
            width: resized.width,
            height: resized.height,
            attempts: tPlural('{count} attempts', resized.attempts)
          }
        ),
        confirmLabel: translate('Save at {size}', { size: miss.achieved }),
        cancelLabel: translate('Don’t save')
      });
      if (!proceed) return;
    }

    const suffix =
      request.targetBytes !== null
        ? `${settings.target.amount}${settings.target.unit.toLowerCase()}`
        : request.width !== null || request.height !== null
          ? `${resized.width}x${resized.height}`
          : `${request.maxDimension ?? 'resized'}px`;
    const name = keepOriginal ? file.name : `${stem(file.name)}-${suffix}.jpg`;
    const saved = await platform.saveFileAs(bytes, name);
    if (!saved) return;
    notify(
      'success',
      keepOriginal
        ? translate('The original already fits, so it was saved unchanged ({size}).', {
            size: formatBytes(bytes.byteLength)
          })
        : translate('Saved {name}: {size}, {width}×{height} px.', {
            name,
            size: formatBytes(bytes.byteLength),
            width: resized.width,
            height: resized.height
          }),
      choice === 'larger'
        ? {
            // Never a silent size increase: the original could not be kept
            // (wrong format, sideways, or outside a limit), so say why the
            // file grew.
            detail: translate(
              'That is larger than the original ({before}), which had to be converted to an upright JPEG to meet your limits.',
              { before: formatBytes(original.byteLength) }
            )
          }
        : undefined
    );
  },

  'images-to-pdf': async ({ job }) => {
    const settings = imagesToPdfSettings.value;
    if (settings.files.length === 0) {
      notify('warning', translate('Nothing to export.'), {
        detail: translate('Add at least one image first.')
      });
      return;
    }

    const { bytes, warnings } = await imagesToPdfBytes(settings.files, job, {
      pageSize: settings.pageSize,
      orientation: settings.orientation,
      margin: settings.margin,
      quality: settings.quality
    });

    const name = settings.files.length === 1 ? `${stem(settings.files[0].name)}.pdf` : 'Images.pdf';
    // UX-04: no "before" PDF exists yet — this builds one from scratch — so
    // it's an after-only review, purely to confirm the layout came out right.
    if (!(await reviewOnly(bytes, name, job))) return;
    const saved = await saveDirectPdf(bytes, name, job);
    if (!saved) return;

    for (const warning of warnings) {
      notify('warning', warning);
    }
    notify('success', translate('PDF saved successfully.'));
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
            ? translate(
                'These pages carry no embedded image XObjects — any pictures you can see are drawn as vectors or text.'
              )
            : summary.reasons.join(' ')
      });
      return;
    }

    if (extractImagesSettings.value.outputFormat === 'directory') {
      if (!(await reviewZipOnly(result.bytes, translate('the extracted images'), job))) return;
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
      const saved = await reviewAndSaveZip(doc, result.bytes, `${stem(doc.name)}-images.zip`);
      if (saved && summary.skippedCount > 0) {
        notify(
          'warning',
          tPlural('{count} images were left in the document.', summary.skippedCount),
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
      // IMG-12: the same bounds the `?target=` link clamps to, refused here
      // rather than silently run with (the field shows the error inline).
      if (!validateSizeParam(compressTarget.value, PDF_TARGET_BOUNDS).ok) {
        notifyInvalidTarget(PDF_TARGET_BOUNDS);
        return;
      }
      const targetBytes = targetSizeBytes(compressTarget.value);
      if (original.byteLength <= targetBytes) {
        notify('info', translate('Already under the target.'), {
          detail: translate(
            '{name} is {size}, which is already at or under {target}. Nothing was changed.',
            {
              name: doc.name,
              size: formatBytes(original.byteLength),
              target: formatBytes(targetBytes)
            }
          )
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
          detail: translate(
            'Every setting Stapler tried produced a larger file than {size}, so all of them were discarded and nothing was written. This document is already as small as it usefully gets.',
            { size: formatBytes(outcome.originalBytes) }
          ),
          timeout: 0
        });
        return;
      }

      if (!outcome.reachedTarget) {
        const skipped =
          outcome.plan && outcome.plan.skipped.length > 0
            ? translate(
                'Some content cannot be re-encoded safely and stays at full size: {items}.',
                { items: outcome.plan.skipped.join('; ') }
              )
            : '';
        const miss = formatTargetMiss(targetBytes, outcome.achievedBytes);
        announceWaiting(job, translate('Waiting for confirmation…'));
        const proceed = await confirmAction({
          title: translate('Could not reach {size}', { size: miss.target }),
          body: [
            translate(
              'The smallest Stapler can produce without destroying this document is {size}, at {dpi} DPI and {quality}% quality — measured, after {attempts}.',
              {
                size: miss.achieved,
                dpi: String(outcome.settings?.dpi),
                quality: Math.round((outcome.settings?.quality ?? 0) * 100),
                attempts: tPlural('{count} attempts', outcome.trials.length)
              }
            ),
            skipped,
            translate('Save that file instead, or keep the original?')
          ]
            .filter(Boolean)
            .join(' '),
          confirmLabel: translate('Save at {size}', { size: miss.achieved }),
          cancelLabel: translate('Keep the original')
        });
        if (!proceed) return;
      }

      // The size actually written, once restrictions/protection are re-applied —
      // not `outcome.achievedBytes`, which is measured before that pass and can
      // undercount it by the handful of bytes the AES pass adds.
      let finalSize = outcome.achievedBytes;
      let savedFastWebView = false;
      const savedTarget = await save(
        doc,
        outcome.bytes,
        `${stem(doc.name)}-compressed.pdf`,
        undefined,
        (finalBytes, info) => {
          finalSize = finalBytes.byteLength;
          savedFastWebView = info.fastWebView;
          if (lastCompressionResult.value?.documentId === doc.id) {
            lastCompressionResult.value = {
              ...lastCompressionResult.value,
              finalBytes: finalBytes.byteLength
            };
          }
        },
        // Not enforced when the user turned Protect on: they asked for encryption
        // on top of compression, which adds bytes by design, and blocking their
        // own explicit choice under the never-grow guarantee would be a worse
        // surprise than the size it exists to prevent. This guard is for the
        // *silent* case — a restriction the document merely arrived with. The
        // ceiling still applies to fast web view (HRD-23), which is dropped
        // rather than allowed to make a compressed file larger than the original.
        {
          maxBytes: outcome.originalBytes,
          enforce: !protectionActive(),
          title: tKey('Kept the original file.'),
          detail: tKey(
            'Re-applying this document’s restrictions after compression would have produced a file no smaller than the original, so nothing was written. This document is already as small as it usefully gets.'
          )
        }
      );
      // IMG-5: "Reached" is said about the file actually written — after
      // Protect or re-applied restrictions, which add bytes — not about the
      // search's measurement before them.
      if (savedTarget && finalSize > targetBytes && outcome.reachedTarget) {
        const miss = formatTargetMiss(targetBytes, finalSize);
        notify(
          'warning',
          translate('Saved at {size}, over the {target} target.', {
            size: miss.achieved,
            target: miss.target
          }),
          {
            detail: translate(
              savedFastWebView
                ? 'Compression reached {reached}, but saving for fast web view (and Protect or this document’s restrictions, if any) added {extra}. Turn fast web view off in the export review, or aim a little lower, to get under the target.'
                : 'Compression reached {reached}, but encrypting the file for Protect (or re-applying its restrictions) added {extra}. Turn Protect off, or aim a little lower, to get under the target.',
              {
                reached: formatBytes(outcome.achievedBytes),
                extra: formatBytesUp(finalSize - outcome.achievedBytes)
              }
            ),
            timeout: 0
          }
        );
      } else if (savedTarget && outcome.reachedTarget) {
        notify('success', translate('Reached {size}', { size: formatBytes(finalSize) }), {
          detail: translate(
            'Target was {target}. {before} → {after} at {dpi} DPI, {quality}% quality.',
            {
              target: formatBytes(targetBytes),
              before: formatBytes(outcome.originalBytes),
              after: formatBytes(finalSize),
              dpi: String(outcome.settings?.dpi),
              quality: Math.round((outcome.settings?.quality ?? 0) * 100)
            }
          )
        });
      }
      return;
    }

    // OPS-19 — grey / black and white as a compression lever. Off by default;
    // when off, everything below runs exactly as it always has.
    const colour = compressColour.value;
    const toGrey = colour !== 'keep';

    // CMP-04: tell the truth *before* spending the user's time, not after.
    // The pre-flight models re-encoding only, so with the grey lever on its
    // "already optimized" verdict says nothing about what B&W will save on a
    // scan, and asking would be wrong.
    const report = await planCompression(original, settings, job);
    if (report.alreadyOptimized && !toGrey) {
      announceWaiting(job, translate('Waiting for confirmation…'));
      const proceed = await confirmAction({
        title: translate('Already optimized'),
        body: [
          translate('Only about {percent}% could be saved from {size}.', {
            percent: Math.max(0, Math.round(report.estimatedFraction * 100)),
            size: formatBytes(report.originalBytes)
          }),
          report.plan.skipped.length > 0
            ? translate('Some content is left untouched: {items}.', {
                items: report.plan.skipped.join('; ')
              })
            : null,
          translate('Compressing anyway will take time for little gain.')
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: translate('Compress anyway'),
        cancelLabel: translate('Leave it alone')
      });
      if (!proceed) return;
    }

    const result = await compressDocument(
      original,
      settings,
      report,
      toGrey && job ? progressBand(job, 0, 0.5) : job
    );
    let output = result.bytes;
    let keptOriginal = result.keptOriginal;
    let greyNote: string | null = null;
    // Said only once the file is written: the pages grey left in colour, or why
    // grey was dropped in favour of the colour-compressed file.
    let afterSave: { title: string; detail: string } | null = null;
    if (toGrey) {
      // Compress first, then convert: see `compress-gray.ts`. `result.bytes` is
      // the original itself when re-encoding did not pay, and grey still runs on
      // it — a colour scan already at its best JPEG is exactly the case B&W is for.
      const grey = await applyGrayLever({
        compressed: result.bytes,
        originalBytes: result.originalBytes,
        pageCount: doc.pages.length,
        mode: colour,
        rasterDpi: settings.dpi,
        job: job ? progressBand(job, 0.5, 1) : undefined
      });
      // Grey did not help, but colour compression alone did: that file is valid
      // and smaller than the original, so it is what gets written — with the
      // reason grey was not applied. Only when neither helps is the original kept.
      const colourFallback = !result.keptOriginal;
      if (grey.kind === 'unverified') {
        if (!colourFallback) {
          notify('danger', translate('The conversion could not be verified — nothing was saved.'), {
            detail: translate(
              'Colour was still found on pages {pages} after converting. Your document is unchanged.',
              { pages: grey.colourLeft.map(i => i + 1).join(', ') }
            ),
            timeout: 0
          });
          return;
        }
        greyNote = translate('Compressed in colour; grey was not applied.');
        afterSave = {
          title: translate('Colour was kept.'),
          detail: translate(
            'Colour was still found on pages {pages} after converting, so the conversion was discarded and the colour-compressed file was saved instead.',
            { pages: grey.colourLeft.map(i => i + 1).join(', ') }
          )
        };
      } else if (grey.kind === 'not-smaller') {
        // Formatted so the larger size never prints the same as the smaller.
        const sizes = formatTargetMiss(result.originalBytes, grey.resultBytes);
        if (!colourFallback) {
          lastCompressionResult.value = {
            documentId: doc.id,
            plan: result.plan,
            originalBytes: result.originalBytes,
            compressedBytes: result.originalBytes,
            keptOriginal: true
          };
          notify('warning', translate('Kept the original file.'), {
            detail: translate(
              '{before} → {after}. Converting to grey did not make this file smaller, so Stapler discarded it and nothing was written. Try again with “Keep colour”.',
              { before: sizes.target, after: sizes.achieved }
            ),
            timeout: 0
          });
          return;
        }
        greyNote = translate('Compressed in colour; grey was not applied.');
        afterSave = {
          title: translate('Colour was kept.'),
          detail: translate(
            'Converting to grey would have made this file {after} (from {before}), no smaller than the original, so the colour-compressed file was saved instead.',
            { before: sizes.target, after: sizes.achieved }
          )
        };
      } else if (grey.kind === 'smaller') {
        output = grey.bytes;
        keptOriginal = false;
        greyNote = greyConvertedNote(colour, grey.gaps, doc.pages.length);
        if (grey.gaps.length > 0) {
          afterSave = {
            title: tPlural('{count} pages were left in colour.', grey.gaps.length),
            detail: greyGapDetail(grey.gaps)
          };
        }
        if (grey.rasterPages > 0) {
          notify('warning', tPlural('{count} pages were rendered as images.', grey.rasterPages), {
            detail: translate(
              'They contain something that cannot be converted to grey directly; their text is no longer selectable.'
            )
          });
        }
      } else {
        // 'already-grey': nothing carried colour, so the compressed bytes stand.
        greyNote = translate('The pages were already grey, so only compression was applied.');
      }
    }

    lastCompressionResult.value = {
      documentId: doc.id,
      plan: result.plan,
      originalBytes: result.originalBytes,
      compressedBytes: output.byteLength,
      keptOriginal,
      // CMP-06's per-image sizes are measured before the grey pass re-encoded
      // those images again, so they would misstate the written file.
      imageStats: output === result.bytes ? result.imageStats : undefined
    };
    if (keptOriginal) {
      notify('warning', translate('Kept the original file.'), {
        detail: translate(
          'Re-encoding produced a larger file, so Stapler discarded it. Nothing was written. This document is already as small as it usefully gets.'
        ),
        timeout: 0
      });
      return;
    }

    // Same reasoning as the target-size branch above: the percentage and the
    // detail string have to reflect the bytes actually written, not the
    // pre-restriction ones `compressDocument` measured.
    let finalSize = output.byteLength;
    const saved = await save(
      doc,
      output,
      `${stem(doc.name)}-compressed.pdf`,
      undefined,
      finalBytes => {
        finalSize = finalBytes.byteLength;
        if (lastCompressionResult.value?.documentId === doc.id) {
          lastCompressionResult.value = {
            ...lastCompressionResult.value,
            finalBytes: finalBytes.byteLength
          };
        }
      },
      // See the target-size branch above: not enforced when Protect is on, since
      // that growth is the user's own explicit choice, not the silent kind this
      // guard exists to catch — but still the ceiling for fast web view.
      {
        maxBytes: result.originalBytes,
        enforce: !protectionActive(),
        title: tKey('Kept the original file.'),
        detail: tKey(
          'Re-applying this document’s restrictions after compression would have produced a file no smaller than the original, so nothing was written. This document is already as small as it usefully gets.'
        )
      }
    );
    if (saved) {
      const percent = Math.round((1 - finalSize / result.originalBytes) * 100);
      const sizes = `${formatBytes(result.originalBytes)} → ${formatBytes(finalSize)}`;
      notify('success', translate('Reduced by {percent}%', { percent }), {
        detail: greyNote ? `${sizes}. ${greyNote}` : sizes
      });
      if (afterSave) notify('warning', afterSave.title, { detail: afterSave.detail, timeout: 0 });
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
    if (doc.annotations.length === 0 && !hasValues && formulas.value.length === 0) {
      notify('warning', translate('Nothing has been placed yet.'), {
        detail: translate(
          'Pick a signature or stamp from the panel, or fill out a form field first.'
        )
      });
      return;
    }

    if (hasValues && formFields.value?.isXfa) {
      // Belt and braces: the overlay never renders fields for an XFA form, so
      // there should be no values — but if any exist, filling them would write to
      // shadow fields the viewer ignores. Refuse before anything is written.
      notify('danger', translate('This is an XFA form — nothing was saved.'), {
        detail: translate(XFA_MESSAGE),
        timeout: 0
      });
      return;
    }

    // "Before": the same compose, minus the signature/stamp layer and form
    // fill, built from `doc.baseline` so the review's diff also shows
    // whatever Organize did since the baseline, not just the marks this tool
    // itself adds.
    const original = await composeDocument(
      { pages: doc.baseline, annotations: doc.annotations, allowXfaLoss: true },
      job
    );

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
    if (hasValues || formulas.value.length > 0) {
      // SGN-07 — the same merge the panel and the on-page overlay already
      // render from, so what was on screen and what lands in `/V` cannot
      // drift. A formula that cannot be computed blocks the save outright:
      // writing the raw override instead would put a wrong or stale number
      // in the field with no indication anything was off.
      const { values, errors } = applyFormulas(
        formulas.value,
        formFields.value?.fields ?? [],
        formValues.value
      );
      if (Object.keys(errors).length > 0) {
        notify(
          'danger',
          translate('A calculated field could not be computed — nothing was saved.'),
          {
            detail: Object.entries(errors)
              .map(([name, message]) => translate('"{name}": {message}', { name, message }))
              .join(' '),
            timeout: 0
          }
        );
        return;
      }
      // SGN-05 — the fill path's own flatten is left to `finalize`, so the two
      // are one decision. With the toggle off the values stay interactive.
      bytes = await fillFormFields(bytes, values, false, job);
    }
    const alignment = alignPages(doc.baseline, doc.pages);
    await reviewAndSave(
      doc,
      original,
      await finalize(bytes, signFlattenOnExport.value, job),
      `${stem(doc.name)}-signed.pdf`,
      job,
      undefined,
      alignment
    );
  },

  normalize: async ({ doc, job }) => {
    // Normalize is the one operation that legitimately resizes pages, so
    // "before" is deliberately un-normalized — built from `doc.baseline` so
    // the review is meant to show the resize itself *and* whatever Organize
    // did since the baseline; its `comparable: false` fallback already
    // handles a resulting size mismatch gracefully, not an edge case.
    const original = await currentDocumentBytes(job, false, doc.baseline);
    const bytes = await currentDocumentBytes(job, true);
    const alignment = alignmentUnlessComposed(doc);
    await reviewAndSave(
      doc,
      original,
      bytes,
      `${stem(doc.name)}-normalized.pdf`,
      undefined,
      undefined,
      alignment
    );
  },

  redact: async ({ doc, job }) => {
    const regions = pendingRedactions.value;

    if (regions.length === 0) {
      notify('warning', translate('No regions are marked.'), {
        detail: translate(
          'Draw a rectangle on the page, or search for text to mark every occurrence.'
        )
      });
      return;
    }

    const original = await currentDocumentBytes(job);
    const outcome = await applyRedactions(original, regions, job);
    redactionReport.value = outcome;

    // RED-03: saving is blocked when any region fails verification.
    if (!outcome.verified) {
      notify('danger', translate('Redaction could not be verified — nothing was saved.'), {
        detail: translate(
          'The report lists which regions failed and why. Your original document is untouched.'
        ),
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
      detail: tPlural(
        '{count} regions removed from the page content and re-checked in the saved bytes. Export to save.',
        regionCount
      ),
      timeout: 0
    });
  },

  metadata: async ({ doc, job }) => {
    // Scrubbing must run on the *current* pages — the file actually being
    // saved — so this stays separate from `original`, which is only for the
    // diff and is built from `doc.baseline` instead: scrubbing itself touches
    // document properties, not page content, so the review's diff isolates to
    // whatever Organize did since the baseline (via `alignment`).
    const current = await currentDocumentBytes(job);
    const scrubbed = await scrubDocumentMetadata(current, scrubSettings.value ?? undefined, job);
    const original = await currentDocumentBytes(job, false, doc.baseline);
    const alignment = alignmentUnlessComposed(doc);
    await reviewAndSave(
      doc,
      original,
      scrubbed,
      `${stem(doc.name)}-scrubbed.pdf`,
      job,
      undefined,
      alignment
    );
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
          detail: translate(
            'Tick pages in the grid, or turn off "Only the pages selected in the grid".'
          )
        });
        return;
      }
    }

    // OCR must run on the *current* pages — the file actually being saved —
    // so this stays separate from `original` below, which is only for the
    // diff and is built from `doc.baseline` instead.
    const current = await currentDocumentBytes(job);
    const result = await runOcr(current, doc.pages.length, {
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
      pages: result.pagesTouched,
      pagesReplaced: result.pagesReplaced,
      pagesSkipped: result.skippedPages.length
    };

    // §2.3 — some pages could not be recognised (most likely an oversized page
    // box past the browser's own canvas limit). The run still completed for
    // the rest, so this is a warning alongside the export, not a reason to
    // refuse it.
    if (result.skippedPages.length > 0) {
      notify(
        'warning',
        tPlural('{count} pages could not be scanned for text', result.skippedPages.length),
        {
          detail: result.skippedPages
            .map(p =>
              translate('Page {page}: {reason}', { page: p.pageIndex + 1, reason: p.reason })
            )
            .join(' ')
        }
      );
    }

    if (result.wordsAdded === 0) {
      notify('warning', translate('OCR found no text on those pages.'), {
        detail: translate(
          'Nothing was exported, and your document is unchanged. A blank, very low-resolution, or heavily skewed scan is the usual cause — try Scan cleanup first.'
        )
      });
      return;
    }

    // Deliberately *not* `finalize`. The flatten toggle belongs to Sign and
    // Annotate, whose panels show the control; OCR has no such setting, so
    // routing its export through that path would silently flatten this document
    // if we threaded the panel choice through from somewhere else.
    // OCR itself adds only an invisible text layer, so the review's diff
    // isolates to whatever Organize did since the baseline (via `alignment`).
    const original = await currentDocumentBytes(job, false, doc.baseline);
    const alignment = alignmentUnlessComposed(doc);
    await reviewAndSave(
      doc,
      original,
      result.bytes,
      `${stem(doc.name)}-ocr.pdf`,
      undefined,
      undefined,
      alignment
    );
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
          detail: translate(
            'Nothing was exported. Table extraction reads text positions, so a scanned page needs OCR first, and a page with no tabular text has nothing to infer.'
          )
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
        detail: translate('{rows} x {columns} from page {page}', {
          rows: tPlural('{count} rows', grid.rowCount),
          columns: tPlural('{count} columns', grid.columnCount),
          page: pageIndex + 1
        })
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
    // UX-04: a contact sheet is a different page layout entirely (a grid of
    // thumbnails per sheet page, not one page per original page), so a
    // page-index diff against the original would compare unrelated pages —
    // after-only review instead.
    // A different page layout entirely, not `doc.pages` — must not be
    // mistaken for "the document, saved" (see `save()`).
    await reviewAndSave(
      doc,
      null,
      sheet,
      `${stem(doc.name)}-contact-sheet.pdf`,
      undefined,
      undefined,
      undefined,
      false
    );
  },
  compare: async () => {},
  // The action bar's "Run Batch" used to be a no-op next to a real button in
  // the panel (UI-9). It now runs the same batch; the action bar's Cancel
  // reaches it through the job signal.
  batch: async ({ job }) => {
    if (!batchIsConfigured()) {
      notify('warning', translate('Choose an input folder and an output first.'));
      return;
    }
    job.signal?.addEventListener('abort', cancelBatch, { once: true });
    await startBatch();
  },
  // ACC-02/ACC-03 — pure reading aids, same as `compare`: nothing here produces
  // a modified document, so there is nothing to export.
  'read-aloud': async () => {},
  reflow: async () => {},
  history: async () => {},
  'side-by-side': async () => {},

  // GAP-6 — greyscale / black-and-white.
  grayscale: async ({ doc, job }) => {
    const settings = grayscaleSettings.value;
    const pageIndices =
      settings.scope === 'selected'
        ? doc.pages
            .map((page, index) => (selectedPageKeys.value.has(page.key) ? index : -1))
            .filter(index => index >= 0)
        : doc.pages.map((_, index) => index);
    if (pageIndices.length === 0) {
      notify('warning', translate('Select the pages to convert first.'), {
        detail: translate('Tick pages in the grid, or choose "All pages".')
      });
      return;
    }

    // Conversion runs on the *current* pages — the file actually being saved.
    const current = await currentDocumentBytes(job);
    const result = await grayscaleDocument(
      current,
      pageIndices,
      doc.pages.length,
      { mode: settings.mode, rasterDpi: settings.rasterDpi },
      job
    );
    if (result.nothingToDo) {
      grayscaleReport.value = null;
      notify('info', translate('Already grey.'), {
        detail: translate(
          'Nothing on those pages carries colour, so there is nothing to convert. Nothing was saved.'
        )
      });
      return;
    }
    grayscaleReport.value = {
      pages: result.pages,
      undecodable: result.undecodable,
      originalBytes: result.originalBytes,
      resultBytes: result.bytes.byteLength,
      mode: settings.mode
    };

    // Proven, not asserted: the output was re-read, and a converted page that
    // still has colour on it blocks the save.
    if (result.colourLeft.length > 0) {
      notify('danger', translate('The conversion could not be verified — nothing was saved.'), {
        detail: translate(
          'Colour was still found on pages {pages} after converting. Your document is unchanged.',
          { pages: result.colourLeft.map(i => i + 1).join(', ') }
        ),
        timeout: 0
      });
      return;
    }

    const rastered = result.pages.filter(p => p.route === 'raster').length;
    if (rastered > 0) {
      notify('warning', tPlural('{count} pages were rendered as images.', rastered), {
        detail: translate(
          'They contain something that cannot be converted directly; their text is no longer selectable. The Grayscale panel lists them with the reason.'
        )
      });
    }
    // Never a silent size increase: B&W is meant to shrink scans, so a file
    // that grew is said out loud before it is written. Not a blocking choice:
    // this tool was asked for grey, which the original is not (`chooseSmaller`
    // with `originalSatisfies: false`), and the export review that follows
    // already shows both sizes before anything is saved.
    const sizeChoice = chooseSmaller({
      originalBytes: result.originalBytes,
      resultBytes: result.bytes.byteLength,
      originalSatisfies: false
    });
    if (sizeChoice === 'larger') {
      // Formatted so the larger size never prints the same as the smaller.
      const sizes = formatTargetMiss(result.originalBytes, result.bytes.byteLength);
      notify('warning', translate('The converted file is larger than the original.'), {
        detail: translate(
          '{before} → {after}. Re-encoding the images as grey cost more than it saved; Compress may help afterwards.',
          { before: sizes.target, after: sizes.achieved }
        ),
        timeout: 0
      });
    }
    // Password protection (or re-applied restrictions) is added in `save()`,
    // after the check above: when that alone pushes the written file past the
    // original, say so — measured on the bytes actually written (pattern 3).
    let finalSize = result.bytes.byteLength;
    let savedFastWebView = false;
    const saved = await reviewAndSave(
      doc,
      current,
      result.bytes,
      `${stem(doc.name)}-${settings.mode === 'bw' ? 'bw' : 'grayscale'}.pdf`,
      job,
      (finalBytes, info) => {
        finalSize = finalBytes.byteLength;
        savedFastWebView = info.fastWebView;
      }
    );
    if (saved && sizeChoice !== 'larger' && finalSize > result.originalBytes) {
      const sizes = formatTargetMiss(result.originalBytes, finalSize);
      notify('warning', translate('The converted file is larger than the original.'), {
        detail: translate(
          savedFastWebView
            ? '{before} → {after}. Converting to grey made it smaller, but saving for fast web view (and password protection or re-applied restrictions, if any) added {extra}.'
            : '{before} → {after}. Converting to grey made it smaller, but encrypting it for password protection (or re-applying its restrictions) added {extra}.',
          {
            before: sizes.target,
            after: sizes.achieved,
            extra: formatBytesUp(finalSize - result.bytes.byteLength)
          }
        ),
        timeout: 0
      });
    }
  },

  // GAP-6 — repair. `worksWithoutDocument`: the file is often one that never
  // opened, so `context.doc` is not trusted.
  repair: async ({ job }) => {
    const doc = activeDoc.value;
    const candidate = repairCandidate.value;
    let bytes: Uint8Array;
    let name: string;
    if (candidate) {
      bytes = new Uint8Array(await candidate.arrayBuffer());
      name = candidate.name;
    } else if (doc) {
      // UI-3: "the open document" means what is on screen — but only its own
      // edits. An untouched document is repaired from its file's raw bytes,
      // the case a damaged file needs: rebuilding it first would let pdf-lib
      // quietly drop the very objects repair could have salvaged. An edited
      // one is composed from its pages, rotations, crops and annotations
      // alone — never the Watermark/Header-footer/N-up panel settings, which
      // are not part of the document.
      const sourceIds = new Set(doc.pages.map(p => p.sourceDocId));
      if (!hasDocumentEdits(doc)) {
        bytes = await readSourceBytes(doc.pages[0].sourceDocId);
      } else {
        try {
          bytes = await composeDocument(
            { pages: doc.pages, annotations: doc.annotations, cropBoxes: cropBoxes.value },
            job
          );
        } catch (err) {
          if (isCancellation(err) || sourceIds.size !== 1) throw err;
          // The edits could not be written into this (damaged) file. Repair the
          // file as it was opened, and say plainly that the edits are not in it.
          bytes = await readSourceBytes([...sourceIds][0]);
          notify('warning', translate('Your edits could not be included.'), {
            detail: translate(
              'This file is too damaged to apply page edits or annotations to, so the original file is repaired instead. Re-open the repaired copy and make the edits again.'
            ),
            timeout: 0
          });
        }
      }
      name = doc.name;
    } else {
      notify('warning', translate('Choose a PDF to repair first.'), {
        detail: translate('Use "Choose a PDF…" in the Repair panel.')
      });
      return;
    }

    const result = await repairDocument(bytes, job);
    const outName = repairedName(name);
    lastRepair.value = { name: outName, result };
    if (!result.changed) {
      notify('info', translate('No damage found.'), {
        detail: translate('{name} opens cleanly as it is, so nothing was saved.', { name })
      });
      return;
    }
    if (!(await reviewOnly(result.bytes, outName, job))) return;
    const saved = await saveDirectPdf(result.bytes, outName, job);
    if (saved) {
      notify('success', translate('Saved {name}', { name: outName }), {
        detail: tPlural('{count} pages recovered and verified.', result.pageCount)
      });
    }
  },
  // CNV-06 — panel only configures the Markdown source (`tools/state.ts`); this is
  // the actual commit, reached the same way every other tool's is: the action
  // bar's single primary CTA (DESIGN-ADAPTATION §4.2). `worksWithoutDocument` on
  // the tool definition means `context.doc` may not correspond to a real open
  // document here — the handler never reads it.
  'md-to-pdf': async ({ job }) => {
    const markdown = markdownToPdfSource.value;
    if (!markdown.trim()) {
      notify('warning', translate('Nothing to export.'), {
        detail: translate('Type or paste some Markdown first.')
      });
      return;
    }
    // CONV-12: cancellable, with progress, like every other long operation.
    const { bytes, hadUnsupportedCharacters, notes } = await processWorker.lease(api =>
      api.markdownToPdf(markdown, createJobHandle(job))
    );
    // UX-04: built from scratch, no "before" PDF to compare against.
    if (!(await reviewOnly(bytes, 'document.pdf', job))) return;
    const saved = await saveDirectPdf(bytes, 'document.pdf', job);
    if (!saved) return;
    if (hadUnsupportedCharacters) {
      notify('warning', translate('PDF saved, but some characters could not be represented.'), {
        detail:
          translate(
            'This export uses a fixed set of Latin fonts and replaced unsupported characters (e.g. CJK, Cyrillic, Arabic) with "?". Affected text will need to be checked manually.'
          ) + (notes.length > 0 ? ` ${notes.join(' ')}` : '')
      });
    } else if (notes.length > 0) {
      // CONV-11/12: dropped links and omitted images are reported, not silent.
      notify('warning', translate('PDF saved with notes.'), { detail: notes.join(' ') });
    } else {
      notify('success', translate('PDF saved successfully.'));
    }
  },
  /**
   * CNV-08 — writes the `.docx` the panel has already converted and previewed.
   *
   * The shared `commitConvertedPreview` above holds the save path all six
   * conversions follow; what is here is only what is specific to this one. The
   * gate in `commit-gate.ts` already disables the action bar's button; the
   * refusal in that helper is the guarantee behind that courtesy, and it also
   * catches a preview belonging to a document the user has since closed — or
   * one edited since the conversion ran, which `pdfToWordPreviewIsStale`
   * decides from `historyVersion` rather than from the document id alone.
   */
  'pdf-to-word': async ({ doc }) => {
    const preview = pdfToWordPreview.value;
    await commitConvertedPreview({
      preview,
      stale: pdfToWordPreviewIsStale(doc.id),
      gate: PDF_TO_WORD_GATE,
      name: () => `${stem(doc.name)}.docx`,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} pages', result.pageCount),
          unconvertedNote(result.skipped, 'failed')
        )
    });
  },
  /**
   * CNV-09 — writes the PDF the panel has already converted and previewed.
   *
   * `worksWithoutDocument` on the tool definition means `context.doc` may not be
   * a real open document, so this handler never reads it — the file name comes
   * from the chosen `.docx`. The output *is* a PDF, so it goes through
   * `protectAsPdf`.
   */
  'word-to-pdf': async ({ job }) => {
    const preview = wordToPdfPreview.value;
    const source = wordToPdfSource.value;
    await commitConvertedPreview({
      preview,
      stale: !source || wordToPdfPreviewIsStale(),
      gate: WORD_TO_PDF_GATE,
      name: () => `${stem(source?.name ?? 'document')}.pdf`,
      protectAsPdf: job,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} pages', result.pageCount),
          unconvertedNote(result.notes, 'failed')
        )
    });
  },
  /**
   * CNV-10 — writes the `.xlsx` the panel has already converted and previewed.
   *
   * Saving the previewed bytes matters more here than for either sibling: every
   * sheet in this output is the result of a guess about where a table was, and
   * re-running the guess at save time would reopen the gap between what was
   * checked and what lands on disk.
   */
  'pdf-to-excel': async ({ doc }) => {
    const preview = pdfToExcelPreview.value;
    await commitConvertedPreview({
      preview,
      stale: pdfToExcelPreviewIsStale(doc.id),
      gate: PDF_TO_EXCEL_GATE,
      name: () => `${stem(doc.name)}.xlsx`,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} sheets', result.sheetCount),
          tPlural('{count} detected tables', result.tableCount),
          unconvertedNote(result.skipped, 'omitted')
        )
    });
  },
  /**
   * CNV-11 — writes the PDF the panel has already converted and previewed. Like
   * CNV-09, the name comes from the chosen workbook rather than from
   * `context.doc`, and the PDF output takes RED-06's protection step.
   */
  'excel-to-pdf': async ({ job }) => {
    const preview = excelToPdfPreview.value;
    const source = excelToPdfSource.value;
    await commitConvertedPreview({
      preview,
      stale: !source || excelToPdfPreviewIsStale(),
      gate: EXCEL_TO_PDF_GATE,
      name: () => `${stem(source?.name ?? 'document')}.pdf`,
      protectAsPdf: job,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} sheets', result.sheets.length),
          tPlural('{count} pages', result.pageCount),
          unconvertedNote(result.notes, 'failed')
        )
    });
  },
  /**
   * CNV-12 — writes the `.pptx` the panel has already converted and previewed.
   *
   * The preview guarantee matters more here than anywhere else in the series:
   * every box on every slide is an approximation of where the page drew
   * something, so re-running the conversion at save time would reopen the gap
   * between what was checked and what lands on disk.
   */
  'pdf-to-ppt': async ({ doc }) => {
    const preview = pdfToPptPreview.value;
    await commitConvertedPreview({
      preview,
      stale: pdfToPptPreviewIsStale(doc.id),
      gate: PDF_TO_PPT_GATE,
      name: () => `${stem(doc.name)}.pptx`,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} slides', result.slideCount),
          tPlural('{count} text boxes', result.textBoxCount),
          unconvertedNote(result.notes, 'omitted')
        )
    });
  },
  /**
   * CNV-13 — writes the PDF the panel has already converted and previewed. Named
   * from the chosen `.pptx`, and protected as the PDF it is.
   */
  'ppt-to-pdf': async ({ job }) => {
    const preview = pptToPdfPreview.value;
    const source = pptToPdfSource.value;
    await commitConvertedPreview({
      preview,
      stale: !source || pptToPdfPreviewIsStale(),
      gate: PPT_TO_PDF_GATE,
      name: () => `${stem(source?.name ?? 'document')}.pdf`,
      protectAsPdf: job,
      detail: (result, bytes) =>
        detailLine(
          formatBytes(bytes.byteLength),
          tPlural('{count} slides', result.slideCount),
          tPlural('{count} pages', result.pageCount),
          unconvertedNote(result.notes, 'failed')
        )
    });
  },
  shortcuts: async () => {}
};

/**
 * UX-04 — every tool whose handler above routes its output through
 * `reviewAndSave`/`reviewAndSaveZip`/`reviewOnly` before anything is written.
 * The single source of truth for that set is the handlers themselves; this
 * list just names them so the action bar can tell the user, up front, that
 * its commit button shows a preview first rather than saving immediately —
 * without duplicating each handler's logic to find out.
 *
 * Deliberately excludes: compress/cleanup (already have a live before/after
 * in-panel), the six CNV-08..13 converters (already gate on a mandatory
 * preview of their own), and anything that never writes a file at all
 * (compare, batch, read-aloud, reflow, history, side-by-side, shortcuts,
 * remove-blanks, redact, table-extract).
 */
export const TOOLS_WITH_EXPORT_REVIEW: ReadonlySet<ToolId> = new Set([
  'merge',
  'organize',
  'insert',
  'extract',
  'nup',
  'crop',
  'watermark',
  'outline',
  'acc',
  'annotate',
  'sign',
  'normalize',
  'metadata',
  'ocr',
  'split',
  'pdf-to-img',
  'extract-img',
  'images-to-pdf',
  'md-to-pdf',
  'contact-sheet',
  'grayscale',
  'repair'
]);

export async function commitTool(toolId: ToolId, job: JobOptions): Promise<void> {
  const doc = activeDoc.value;
  const tool = findTool(toolId);
  if (!doc && !tool?.worksWithoutDocument) throw internal('No document is open.');
  // A document can reach zero pages (`deletePages` has no last-page guard —
  // select-all-and-delete is a legitimate way to clear a document before
  // starting over). Left uncaught, this reached `composeDocument`'s own
  // `internal('There are no pages to export.')` deep inside whichever
  // handler ran, which reads to the user as "Stapler crashed" (`InternalError`'s
  // copy literally says "file an issue") for an entirely ordinary state. Caught
  // once, here, for every tool, rather than duplicated in each handler that
  // would otherwise hit it a different way.
  if (doc && doc.pages.length === 0) {
    notify('warning', translate('Nothing to export.'), {
      detail: translate('This document has no pages. Undo the deletion, or open a different file.')
    });
    return;
  }
  const handler = HANDLERS[toolId];
  if (!handler) throw internal(`No commit action is defined for the ${toolId} tool.`);
  // `worksWithoutDocument` tools (md-to-pdf, batch) never read `context.doc`; the
  // cast keeps `CommitContext` simple for the many handlers that do require one.
  await handler({ doc: doc as StaplerDoc, job });
}

/** Re-exported so the extract panel can share the text pipeline. */
export { extractDocumentText, extractSettings, removeBlanksThreshold };
