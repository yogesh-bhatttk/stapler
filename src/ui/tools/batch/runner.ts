import { translate } from '../../../core/i18n';
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
import { zipSync } from 'fflate';

/** Appends a per-file outcome to the run summary. */
function addNote(note: BatchNote): void {
  batchProgress.value = {
    ...batchProgress.value,
    notes: [...batchProgress.value.notes, note]
  };
}

export async function runBatch(signal?: AbortSignal) {
  const inDir = inputDirHandle.value;
  const outDir = outputDirHandle.value;
  const outZip = outputZipHandle.value;
  if (!inDir || (outputFormat.value === 'directory' ? !outDir : !outZip)) return;

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
      detail:
        'Choose a different output folder. Running batch in-place would overwrite your originals.'
    });
    return;
  }

  const recipe = activeRecipeId.value
    ? savedRecipes.value.find(r => r.id === activeRecipeId.value)
    : null;

  // If a recipe is active, only the tools it lists are applied, in the order
  // they appear in recipe.tools. Without this gate every tool was unconditionally
  // applied even if the recipe was created for watermark-only or compress-only.
  // Fall back to sensible defaults when no recipe is active.
  const activeTools: string[] = recipe?.tools ?? ['watermark', 'compress'];

  // A recipe replays *its own* snapshot. It must never reach for a live signal:
  // that is how a saved recipe silently picked up whatever the N-up or Normalize
  // panel happened to have open at run time. A setting the recipe does not carry
  // means "this recipe does not configure that tool", not "ask the current UI".
  const compress = recipe ? recipe.settings.compress : compressSettings.value;
  const watermark = recipe ? recipe.settings.watermark : watermarkSettings.value;
  const headerFooter = recipe ? recipe.settings.headerFooter : headerFooterSettings.value;
  const nup = recipe ? recipe.settings.nup : nupSettings.value;
  const normalize = recipe ? recipe.settings.normalize : normalizeSettings.value;

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
        detail: `"${recipe.name}" lists ${missing.join(', ')} but has no saved settings for ${missing.length === 1 ? 'it' : 'them'}, so ${missing.length === 1 ? 'it' : 'they'} will be skipped. Re-save the recipe to capture the current settings.`
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

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const fileHandle = files[fileIndex];
      if (signal?.aborted) {
        notify('warning', translate('Batch Cancelled'), {
          detail: 'Processing was cancelled by the user.'
        });
        break;
      }
      batchProgress.value = { ...batchProgress.value, currentFile: fileHandle.name };
      try {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        const { processWorker } = await import('../../../core/workers');
        const { hasWatermarkContent, hasHeaderFooterContent } = await import('../watermark/state');

        let currentBytes = bytes;
        // Set only when a 'compress' step actually ran (not when it was
        // skipped as already-optimized) — the bytes fed into it, so the
        // never-grow guard below has something to fall back to.
        let preCompressBytes: Uint8Array | null = null;

        // Apply tools in the order declared by recipe.tools (or defaults).
        for (const toolId of activeTools) {
          if (toolId === 'watermark' || toolId === 'normalize' || toolId === 'nup') {
            // Re-inspect current bytes so page maps reflect the document state
            // after any preceding tools (e.g. nup layout changes).
            const inspect = await processWorker.lease(api => api.inspect(currentBytes));
            const pages = Array.from({ length: inspect.pageCount }).map((_, i) => ({
              key: `${fileHandle.name}-${i}`,
              sourceDocId: fileHandle.name,
              sourceIndex: i,
              rotation: 0
            }));

            if (toolId === 'watermark') {
              const applyWatermark = watermark && hasWatermarkContent(watermark);
              const applyHF = headerFooter && hasHeaderFooterContent(headerFooter);
              if (applyWatermark || applyHF) {
                currentBytes = await processWorker.lease(api =>
                  api.compose(
                    pages,
                    { [fileHandle.name]: currentBytes },
                    [],
                    applyWatermark ? (watermark as unknown as WatermarkData) : undefined,
                    applyHF ? headerFooter : undefined,
                    undefined,
                    undefined,
                    [],
                    undefined
                  )
                );
              }
            } else if (toolId === 'normalize') {
              currentBytes = await processWorker.lease(api =>
                api.compose(
                  pages,
                  { [fileHandle.name]: currentBytes },
                  [],
                  undefined,
                  undefined,
                  normalize,
                  undefined,
                  [],
                  undefined
                )
              );
            } else if (toolId === 'nup') {
              currentBytes = await processWorker.lease(api =>
                api.compose(
                  pages,
                  { [fileHandle.name]: currentBytes },
                  [],
                  undefined,
                  undefined,
                  undefined,
                  nup,
                  [],
                  undefined
                )
              );
            }
          } else if (toolId === 'compress' && compress) {
            const report = await planCompression(currentBytes, compress);
            // CMP-04: a compress that cannot beat the input keeps the input. The
            // file is still written (later tools in the recipe may change it),
            // but the run has to say so — a batch that quietly emitted identical
            // copies looked exactly like a batch that had compressed them.
            if (report.alreadyOptimized) {
              addNote({
                file: fileHandle.name,
                kind: 'kept-original',
                detail: 'Already optimised — there was nothing left to compress.'
              });
            } else {
              preCompressBytes = currentBytes;
              const res = await compressDocument(currentBytes, compress, report);
              if (res.keptOriginal) {
                addNote({
                  file: fileHandle.name,
                  kind: 'kept-original',
                  detail: 'Compressing would have made this file larger, so it was left unchanged.'
                });
              } else {
                currentBytes = res.bytes;
              }
            }
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
              detail: `Removed ${count} metadata finding${count === 1 ? '' : 's'}.`
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
          const withoutCompress =
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
          if (currentBytes.byteLength > withoutCompress.byteLength) {
            currentBytes = withoutCompress;
            addNote({
              file: fileHandle.name,
              kind: 'kept-original',
              detail:
                'Reapplying this document’s restrictions after compression would have produced a file no smaller than skipping compression, so the compressed version was discarded.'
            });
          }
        }

        // Save output
        // BAT-03: use the pre-resolved output name for this file.
        const outName = `${stripPdfExtension(resolvedNames[fileIndex])}.pdf`;
        if (outputFormat.value === 'zip') {
          zipEntries[outName] = currentBytes;
        } else {
          const outHandle = await outDir!.getFileHandle(outName, { create: true });
          const writable = await outHandle.createWritable();
          try {
            await writable.write(currentBytes);
            await writable.close();
          } catch (writeErr) {
            await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
            throw writeErr;
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

    if (outputFormat.value === 'zip' && outZip) {
      batchProgress.value = { ...batchProgress.value, currentFile: 'Saving ZIP archive...' };
      const zipBytes = zipSync(zipEntries);
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
    notify(kept.length > 0 ? 'info' : 'success', 'Batch Processing Complete', {
      detail:
        `Successfully processed ${batchProgress.value.completed} files. ` +
        `${batchProgress.value.failed} failed.` +
        (kept.length > 0
          ? ` ${kept.length} ${kept.length === 1 ? 'file was' : 'files were'} written unchanged ` +
            `because compressing would not have made ${kept.length === 1 ? 'it' : 'them'} smaller: ` +
            `${kept.map(n => n.file).join(', ')}.`
          : ''),
      timeout: kept.length > 0 ? 0 : undefined
    });
  } catch (err) {
    console.error(err);
    notify('danger', translate('Batch Processing Failed'), { detail: String(err) });
  } finally {
    batchProgress.value = { ...batchProgress.value, isProcessing: false };
  }
}
