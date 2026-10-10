import { tPlural, translate } from '../../../core/i18n';
import {
  batchProgress,
  inputDirHandle,
  outputDirHandle,
  activeRecipeId,
  savedRecipes,
  outputPattern,
  outputFormat,
  outputZipHandle,
  scrubMetadataInBatch,
  type BatchNote
} from './state';
import {
  stripAllMetadataSettings,
  hasAnyMetadataFinding,
  countMetadataFindings
} from '../../../core/metadata-scrub';
import { compressSettings } from '../compress/state';
import { watermarkSettings, headerFooterSettings } from '../watermark/state';
import { nupSettings } from '../nup/state';
import { normalizeSettings } from '../normalize/state';
import { compressDocument, planCompression } from '../../../core/operations';
import type { WatermarkData } from '../../../core/workers/process.worker';
import { notify } from '../../../core/notify';
import {
  applyFilenamePattern,
  stripPdfExtension,
  deduplicateNames
} from '../../../core/batch-filename';
import { corrupt } from '../../../core/errors';
import { looksLikePdf } from '../../../core/import';
import { zipInWorker } from '../../../core/zip';
import { directoryOutput } from '../../../platform/file-system';
import { isCancellation } from '../../../core/errors';
import { parseRecipe } from './recipe-settings';
import { createJobHandle } from '../../../core/workers/protocol';

/** M5 — the one "cancelled" outcome toast, with what (if anything) was written. */
function notifyBatchCancelled(): void {
  const written = batchProgress.value.completed;
  notify('warning', translate('Batch Cancelled'), {
    detail:
      outputFormat.value === 'zip'
        ? translate('Processing was cancelled by the user. No ZIP archive was written.')
        : tPlural(
            'Processing was cancelled by the user. {count} files were already saved to the output folder.',
            written
          )
  });
}

/** Appends a per-file outcome to the run summary. */
function addNote(note: BatchNote): void {
  batchProgress.value = {
    ...batchProgress.value,
    notes: [...batchProgress.value.notes, note]
  };
}

/**
 * Audit P4/P6 — a worker notice (an item a rebuild could not carry, an
 * annotation outside a crop) as one summary note per file and message.
 */
function noteChanged(file: string, detail: string): void {
  const seen = batchProgress.value.notes.some(
    n => n.kind === 'changed' && n.file === file && n.detail === detail
  );
  if (!seen) addNote({ file, kind: 'changed', detail });
}

/** A job handle whose notices land in this file's summary notes. */
function fileNoticeJob(file: string) {
  return createJobHandle({ onNotice: message => noteChanged(file, message) });
}

// §2.1 — a synchronous reentrancy guard, set before this function's first
// `await`. `batchProgress.value.isProcessing` alone is not enough: it only
// flips true after the `isSameEntry()` await below, so a fast double-click or
// double-Enter on "Run Batch" before the first render disables the button
// could start two concurrent runs, both mutating `batchProgress` and both
// writing to the same output directory or ZIP handle. Checking and setting a
// module-level flag synchronously closes that window — nothing can interleave
// between the check and the set within one synchronous stretch of JS.
let batchRunInFlight = false;

/**
 * The running batch's controller, at module scope. It used to live in the
 * panel's `useRef`: switch tool and come back, and the remounted panel showed
 * Cancel (from the global `isProcessing`) wired to a null ref — the run could
 * no longer be stopped (AUDIT-2026-09-25 UI-9).
 */
let batchController: AbortController | null = null;

/** Whether input and output are chosen, i.e. whether `startBatch` would do anything. */
export function batchIsConfigured(): boolean {
  if (!inputDirHandle.value) return false;
  return outputFormat.value === 'directory' ? !!outputDirHandle.value : !!outputZipHandle.value;
}

/** Starts a batch run unless one is already going; resolves when it ends. */
export async function startBatch(): Promise<void> {
  if (batchController) return;
  const controller = new AbortController();
  batchController = controller;
  try {
    await runBatch(controller.signal);
  } finally {
    if (batchController === controller) batchController = null;
  }
}

/** Cancels the running batch, from whichever panel instance (or the action bar) asks. */
export function cancelBatch(): void {
  batchController?.abort();
}

export async function runBatch(signal?: AbortSignal) {
  const inDir = inputDirHandle.value;
  const outDir = outputDirHandle.value;
  const outZip = outputZipHandle.value;
  if (!inDir || (outputFormat.value === 'directory' ? !outDir : !outZip)) return;
  if (batchRunInFlight) return;
  batchRunInFlight = true;
  try {
    await runBatchBody(signal, inDir, outDir, outZip);
  } finally {
    batchRunInFlight = false;
  }
}

async function runBatchBody(
  signal: AbortSignal | undefined,
  inDir: NonNullable<typeof inputDirHandle.value>,
  outDir: typeof outputDirHandle.value,
  outZip: typeof outputZipHandle.value
) {
  // Safety: if the input and output directory are the same filesystem entry,
  // a batch run would overwrite the source files in-place with no backup —
  // the output handle is opened with { create: true } using the same filename,
  // silently destroying the original. Reject upfront with a clear message.
  if (
    outputFormat.value === 'directory' &&
    outDir &&
    typeof inDir.isSameEntry === 'function' &&
    (await inDir.isSameEntry(outDir as unknown as FileSystemHandle))
  ) {
    notify('danger', translate('Input and output folders are the same'), {
      detail: translate(
        'Choose a different output folder. Running batch in-place would overwrite your originals.'
      )
    });
    return;
  }

  const recipe = activeRecipeId.value
    ? savedRecipes.value.find(r => r.id === activeRecipeId.value)
    : null;

  // A stored recipe's tools and settings are unchecked (`core/db.ts` types them
  // `unknown`): an older build or an imported file may have written anything.
  // Check them once, here, and refuse to run on a malformed one — a bad slice
  // used to reach the worker as-is and either crash it mid-folder or stamp
  // pages with nonsense values (AUDIT-2026-10-01 X-15).
  const parsed = recipe ? parseRecipe(recipe) : null;
  if (recipe && parsed && !parsed.ok) {
    notify('danger', translate('Recipe settings could not be read'), {
      detail: translate(
        '"{name}" has settings this version cannot use ({fields}). No files were processed. Delete the recipe and save it again.',
        { name: recipe.name, fields: parsed.problems.join(', ') }
      )
    });
    return;
  }
  const replay = parsed?.ok ? parsed.recipe : null;

  // If a recipe is active, only the tools it lists are applied, in the order
  // they appear in recipe.tools. Without this gate every tool was unconditionally
  // applied even if the recipe was created for watermark-only or compress-only.
  // Fall back to sensible defaults when no recipe is active.
  const activeTools: string[] = replay?.tools ?? ['watermark', 'compress'];

  // A recipe replays *its own* snapshot. It must never reach for a live signal:
  // that is how a saved recipe silently picked up whatever the N-up or Normalize
  // panel happened to have open at run time. A setting the recipe does not carry
  // means "this recipe does not configure that tool", not "ask the current UI".
  const compress = replay ? replay.settings.compress : compressSettings.value;
  const watermark = replay ? replay.settings.watermark : watermarkSettings.value;
  const headerFooter = replay ? replay.settings.headerFooter : headerFooterSettings.value;
  const nup = replay ? replay.settings.nup : nupSettings.value;
  const normalize = replay ? replay.settings.normalize : normalizeSettings.value;

  if (recipe) {
    // Recipes saved by older builds can list a tool whose settings were never
    // recorded. Skipping it silently looks exactly like the tool running and
    // doing nothing, so say which ones are inert.
    const configured: Record<string, unknown> = {
      compress,
      watermark,
      headerFooter,
      nup,
      normalize
    };
    const missing = activeTools.filter(
      tool => tool in configured && configured[tool] === undefined
    );
    if (missing.length > 0) {
      notify('warning', translate('Recipe is missing settings'), {
        detail: tPlural(
          '"{name}" lists {tools} but has no saved settings for them, so they will be skipped. Re-save the recipe to capture the current settings.',
          missing.length,
          { name: recipe.name, tools: missing.join(', ') }
        )
      });
    }
  }

  batchProgress.value = {
    total: 0,
    completed: 0,
    failed: 0,
    currentFile: '',
    isProcessing: true,
    notes: []
  };

  try {
    const files: FileSystemFileHandle[] = [];
    const inDirIterable = inDir as unknown as {
      values: () => AsyncIterableIterator<FileSystemFileHandle>;
    };
    if (typeof inDirIterable.values === 'function') {
      for await (const entry of inDirIterable.values()) {
        if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
          files.push(entry);
        }
      }
    }

    batchProgress.value = { ...batchProgress.value, total: files.length };

    const zipEntries: Record<string, Uint8Array> = {};

    // BAT-03: pre-resolve all output names so collisions are detected upfront.
    const runDate = new Date();
    const pattern = outputPattern.value || '{basename}';
    const rawNames = files.map((fh, i) =>
      applyFilenamePattern(pattern, stripPdfExtension(fh.name), i + 1, files.length, runDate)
    );
    const resolvedNames = deduplicateNames(rawNames);

    // AUDIT-2026-10-10 L4 — the same never-overwrite writer as every other
    // folder export: a name already in the output folder (an earlier run's
    // output, or anything else) gets " (n)" instead of being replaced.
    const folder =
      outputFormat.value === 'directory' && outDir
        ? directoryOutput(outDir as unknown as Parameters<typeof directoryOutput>[0])
        : null;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const fileHandle = files[fileIndex];
      // M5 — the cancel toast is raised once, after the loop.
      if (signal?.aborted) break;
      batchProgress.value = { ...batchProgress.value, currentFile: fileHandle.name };
      try {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Batch had no equivalent of importPdf()'s validation gate: a non-PDF file
        // fell straight into pdf-lib's tolerant parser and surfaced a raw internal
        // TypeError, and a truncated file could silently lose trailing pages with
        // no error at all (AUDIT-EDGE-CASES-2026-09-15 §1.8 in docs/TICKETS.md EPIC-19). Mirror the
        // single-file import path's checks — magic-byte sniff, then the pdf.js
        // parse importPdf() also uses as the real corruption gate — so a bad file
        // in a batch folder fails the same clear, classified way an equally bad
        // file would fail through "Add PDF".
        if (bytes.length === 0) throw corrupt('The file is empty.');
        if (!looksLikePdf(bytes)) {
          throw corrupt('The file does not start with a PDF header, so it is not a PDF.');
        }

        const { processWorker, renderWorker } = await import('../../../core/workers');
        const { hasWatermarkContent, hasHeaderFooterContent } = await import('../watermark/state');

        const validationClient = renderWorker.pin();
        try {
          const info = await validationClient.lease(api => api.loadDocument(bytes));
          try {
            if (info.pageCount === 0) throw corrupt('The document contains no pages.');
          } finally {
            await validationClient.lease(api => api.closeDocument(info.handle));
          }
        } finally {
          validationClient.release();
        }

        let currentBytes = bytes;
        // Set only when a 'compress' step actually ran (not when it was
        // skipped as already-optimized) — the bytes fed into it, so the
        // never-grow guard below has something to fall back to.
        let preCompressBytes: Uint8Array | null = null;
        // Index of the 'compress' step within `activeTools`, so the never-grow
        // guard below knows which later tools (if any) it would have to replay.
        let compressIndex = -1;

        /**
         * Applies one non-'compress' tool to `inputBytes`, returning the result.
         *
         * Factored out so the never-grow guard below can call it a second time —
         * on the pre-compress bytes, for a recipe where 'compress' does not run
         * last — without duplicating this logic. `compose` is idempotent given
         * the same inputs, so calling it twice for the same tool costs an extra
         * worker round trip, not a different answer.
         */
        const applyNonCompressTool = async (
          toolId: string,
          inputBytes: Uint8Array
        ): Promise<Uint8Array> => {
          if (toolId !== 'watermark' && toolId !== 'normalize' && toolId !== 'nup') {
            return inputBytes;
          }
          // Audit P4/P6 — what a rebuild had to leave out, as this file's note
          // in the run summary rather than one toast per file.
          const job = fileNoticeJob(fileHandle.name);
          // Re-inspect current bytes so page maps reflect the document state
          // after any preceding tools (e.g. nup layout changes).
          const inspect = await processWorker.lease(api => api.inspect(inputBytes));
          const pages = Array.from({ length: inspect.pageCount }).map((_, i) => ({
            key: `${fileHandle.name}-${i}`,
            sourceDocId: fileHandle.name,
            sourceIndex: i,
            rotation: 0
          }));

          if (toolId === 'watermark') {
            const applyWatermark = watermark && hasWatermarkContent(watermark);
            const applyHF = headerFooter && hasHeaderFooterContent(headerFooter);
            if (!applyWatermark && !applyHF) return inputBytes;
            return processWorker.lease(api =>
              api.compose(
                pages,
                { [fileHandle.name]: inputBytes },
                [],
                applyWatermark ? (watermark as unknown as WatermarkData) : undefined,
                applyHF ? headerFooter : undefined,
                undefined,
                undefined,
                [],
                job
              )
            );
          }
          if (toolId === 'normalize') {
            return processWorker.lease(api =>
              api.compose(
                pages,
                { [fileHandle.name]: inputBytes },
                [],
                undefined,
                undefined,
                normalize,
                undefined,
                [],
                job
              )
            );
          }
          // toolId === 'nup'
          return processWorker.lease(api =>
            api.compose(
              pages,
              { [fileHandle.name]: inputBytes },
              [],
              undefined,
              undefined,
              undefined,
              nup,
              [],
              job
            )
          );
        };

        // Apply tools in the order declared by recipe.tools (or defaults).
        for (let toolIndex = 0; toolIndex < activeTools.length; toolIndex++) {
          const toolId = activeTools[toolIndex];
          if (toolId === 'compress' && compress) {
            compressIndex = toolIndex;
            const report = await planCompression(currentBytes, compress);
            // CMP-04: a compress that cannot beat the input keeps the input. The
            // file is still written (later tools in the recipe may change it),
            // but the run has to say so — a batch that quietly emitted identical
            // copies looked exactly like a batch that had compressed them.
            if (report.alreadyOptimized) {
              addNote({
                file: fileHandle.name,
                kind: 'kept-original',
                detail: translate('Already optimised — there was nothing left to compress.')
              });
            } else {
              preCompressBytes = currentBytes;
              const res = await compressDocument(currentBytes, compress, report, {
                onNotice: message => noteChanged(fileHandle.name, message)
              });
              if (res.keptOriginal) {
                addNote({
                  file: fileHandle.name,
                  kind: 'kept-original',
                  detail: translate(
                    'Compressing would have made this file larger, so it was left unchanged.'
                  )
                });
              } else {
                currentBytes = res.bytes;
              }
            }
          } else {
            currentBytes = await applyNonCompressTool(toolId, currentBytes);
          }
        }

        // RED-09: scrub metadata last, from this file's own findings — never
        // from another file's, and never from settings a recipe happened to
        // carry, since a batch run has no per-item checkbox to consult.
        if (scrubMetadataInBatch.value) {
          const findings = await processWorker.lease(api => api.readMetadata(currentBytes));
          const settings = stripAllMetadataSettings(findings);
          if (hasAnyMetadataFinding(settings)) {
            currentBytes = await processWorker.lease(api =>
              api.scrubMetadata(currentBytes, settings)
            );
            const count = countMetadataFindings(findings);
            addNote({
              file: fileHandle.name,
              kind: 'metadata-scrubbed',
              detail: tPlural('Removed {count} metadata findings.', count)
            });
          }
        }

        // A file that arrived permission-restricted must not leave
        // unrestricted. Opening one means decrypting it (`core/pdf/load.ts`),
        // and a decrypted document has no `/Encrypt` left to carry its `/P`
        // forward — so the flags are read back off the input's own bytes and
        // re-applied here, exactly as `ui/tools/commit.ts` does for every
        // single-document export.
        //
        // Only when something actually rewrote the file: an untouched
        // `currentBytes` *is* the input, `/Encrypt` and all, and re-encrypting
        // it would be both pointless and a second parse per batch item.
        let permissionRestrictions: number | null = null;
        if (currentBytes !== bytes) {
          const inspected = await processWorker.lease(api => api.inspect(bytes));
          if (typeof inspected.permissionRestrictions === 'number') {
            permissionRestrictions = inspected.permissionRestrictions;
            currentBytes = await processWorker.lease(api =>
              api.restrictDocument(currentBytes, permissionRestrictions as number)
            );
          }
        }

        // CLAUDE.md's never-grow guarantee for "compress" applies here too,
        // and restriction reapplication is exactly where it can be broken:
        // re-encrypting adds a fresh `/Encrypt` dictionary, hex-string
        // ciphertext, and forces `useObjectStreams: false` (no xref stream),
        // which together can outweigh what compression saved — silently
        // handing back a batch file larger than skipping compression would
        // have, on a document merely restricted enough that compressing it
        // was never worth it. Compared against skipping compression
        // altogether — restricted the same way this file's actual output
        // was, so a real restriction cost isn't mistaken for one compression
        // caused — not the bare pre-compress bytes.
        if (preCompressBytes) {
          const withoutCompressBase =
            preCompressBytes === bytes
              ? bytes
              : permissionRestrictions !== null
                ? await processWorker.lease(api =>
                    api.restrictDocument(
                      preCompressBytes as Uint8Array,
                      permissionRestrictions as number
                    )
                  )
                : preCompressBytes;

          // §4 — this comparison used to stop here, which is correct only when
          // 'compress' was the last tool to touch the bytes. For a non-default
          // recipe order (e.g. compress before watermark), `currentBytes` also
          // carries whatever ran *after* compress, while `withoutCompressBase`
          // does not — so a discard fell all the way back to the pre-compress,
          // pre-watermark bytes, silently throwing away the watermark too. The
          // note below only ever mentioned the compressed version being
          // discarded, which was no longer the whole truth.
          //
          // `withoutCompressBase` is a safe, cheap lower bound on the correct
          // counterfactual: replaying more tools onto it can only add bytes, not
          // remove them, so if `currentBytes` already fits under this bound it
          // is guaranteed to fit under the correct one too, and the expensive
          // replay below is skipped on every batch item that does not need it.
          if (currentBytes.byteLength > withoutCompressBase.byteLength) {
            // Replayed from `preCompressBytes`, not from `withoutCompressBase`:
            // a downstream tool's `compose` rebuilds the document from scratch,
            // which does not carry the source's real `/Encrypt` dictionary
            // forward the way leaving `bytes` byte-for-byte untouched does. So
            // restriction has to be (re)applied *after* the replay, exactly
            // once, exactly as the real pipeline above applies it once after
            // every content-changing tool has run — not baked into the base
            // before tools that change the content run on top of it.
            let withoutCompressContent = preCompressBytes;
            for (let i = compressIndex + 1; i < activeTools.length; i++) {
              withoutCompressContent = await applyNonCompressTool(
                activeTools[i],
                withoutCompressContent
              );
            }
            const withoutCompress =
              withoutCompressContent === preCompressBytes
                ? withoutCompressBase // nothing replayed; already computed above
                : permissionRestrictions !== null
                  ? await processWorker.lease(api =>
                      api.restrictDocument(
                        withoutCompressContent as Uint8Array,
                        permissionRestrictions as number
                      )
                    )
                  : withoutCompressContent;

            if (currentBytes.byteLength > withoutCompress.byteLength) {
              currentBytes = withoutCompress;
              addNote({
                file: fileHandle.name,
                kind: 'kept-original',
                detail:
                  compressIndex < activeTools.length - 1
                    ? translate(
                        'Compressing this document did not make the final file any smaller once its restrictions and later steps were reapplied, so the compressed version was discarded and those later steps were redone without it.'
                      )
                    : translate(
                        'Reapplying this document’s restrictions after compression would have produced a file no smaller than skipping compression, so the compressed version was discarded.'
                      )
              });
            }
          }
        }

        // Save output
        // BAT-03: use the pre-resolved output name for this file.
        const outName = `${stripPdfExtension(resolvedNames[fileIndex])}.pdf`;
        if (outputFormat.value === 'zip') {
          zipEntries[outName] = currentBytes;
        } else {
          const written = await folder!.write(outName, currentBytes);
          if (written !== outName) {
            addNote({
              file: fileHandle.name,
              kind: 'renamed',
              detail: translate(
                'Saved as {name}, because {original} already exists in the output folder.',
                { name: written, original: outName }
              )
            });
          }
        }

        batchProgress.value = {
          ...batchProgress.value,
          completed: batchProgress.value.completed + 1
        };
      } catch (err) {
        console.error(`Failed to process ${fileHandle.name}`, err);
        notify('danger', translate('Failed to process {name}', { name: fileHandle.name }), {
          detail: err instanceof Error ? err.message : String(err)
        });
        addNote({
          file: fileHandle.name,
          kind: 'failed',
          detail: err instanceof Error ? err.message : String(err)
        });
        batchProgress.value = { ...batchProgress.value, failed: batchProgress.value.failed + 1 };
      }
    }

    // AUDIT-2026-10-10 M5 — a cancelled run reports itself as cancelled and,
    // for ZIP output, writes nothing: opening the chosen file's writable used
    // to truncate it to whatever partial (or empty) archive the run had got
    // to, then announce "Batch Processing Complete".
    if (signal?.aborted) {
      notifyBatchCancelled();
      return;
    }

    if (outputFormat.value === 'zip' && outZip) {
      batchProgress.value = {
        ...batchProgress.value,
        currentFile: translate('Saving ZIP archive...')
      };
      // Built in the zip worker, PDFs stored rather than deflated again.
      let zipBytes: Uint8Array;
      try {
        zipBytes = await zipInWorker(zipEntries, { signal, transfer: true });
      } catch (err) {
        if (!isCancellation(err)) throw err;
        notifyBatchCancelled();
        return;
      }
      if (signal?.aborted) {
        notifyBatchCancelled();
        return;
      }
      const writable = await outZip.createWritable();
      try {
        await writable.write(zipBytes);
        await writable.close();
      } catch (writeErr) {
        await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
        throw writeErr;
      }
    }

    const kept = batchProgress.value.notes.filter(n => n.kind === 'kept-original');
    const renamed = batchProgress.value.notes.filter(n => n.kind === 'renamed');
    const changed = [
      ...new Set(batchProgress.value.notes.filter(n => n.kind === 'changed').map(n => n.file))
    ];
    notify(
      kept.length > 0 || changed.length > 0 || renamed.length > 0 ? 'info' : 'success',
      translate('Batch Processing Complete'),
      {
        detail: [
          tPlural('Successfully processed {count} files.', batchProgress.value.completed),
          tPlural('{count} failed.', batchProgress.value.failed),
          kept.length > 0
            ? tPlural(
                '{count} files were written unchanged because compressing would not have made them smaller: {files}.',
                kept.length,
                { files: kept.map(n => n.file).join(', ') }
              )
            : null,
          changed.length > 0
            ? translate(
                'Some files had parts changed or left out — see the notes in the Batch panel: {files}.',
                { files: changed.join(', ') }
              )
            : null,
          renamed.length > 0
            ? tPlural(
                '{count} files were saved with a number added, because a file of that name was already in the output folder — nothing was replaced.',
                renamed.length
              )
            : null
        ]
          .filter(Boolean)
          .join(' '),
        timeout: kept.length > 0 || changed.length > 0 || renamed.length > 0 ? 0 : undefined
      }
    );
  } catch (err) {
    console.error(err);
    notify('danger', translate('Batch Processing Failed'), { detail: String(err) });
  } finally {
    batchProgress.value = { ...batchProgress.value, isProcessing: false };
  }
}
