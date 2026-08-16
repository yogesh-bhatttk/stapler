import {
  batchProgress,
  inputDirHandle,
  outputDirHandle,
  activeRecipeId,
  savedRecipes,
  outputPattern
} from './state';
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

export async function runBatch(signal?: AbortSignal) {
  const inDir = inputDirHandle.value;
  const outDir = outputDirHandle.value;
  if (!inDir || !outDir) return;

  // Safety: if the input and output directory are the same filesystem entry,
  // a batch run would overwrite the source files in-place with no backup —
  // the output handle is opened with { create: true } using the same filename,
  // silently destroying the original. Reject upfront with a clear message.
  if (
    typeof inDir.isSameEntry === 'function' &&
    (await inDir.isSameEntry(outDir as unknown as FileSystemHandle))
  ) {
    notify('danger', 'Input and output folders are the same', {
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

  const compress = recipe ? recipe.settings.compress : compressSettings.value;
  const watermark = recipe ? recipe.settings.watermark : watermarkSettings.value;
  const headerFooter = recipe ? recipe.settings.headerFooter : headerFooterSettings.value;
  const nup = recipe ? recipe.settings.nup : nupSettings.value;
  const normalize = recipe ? recipe.settings.normalize : normalizeSettings.value;

  batchProgress.value = {
    total: 0,
    completed: 0,
    failed: 0,
    currentFile: '',
    isProcessing: true
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
        notify('warning', 'Batch Cancelled', { detail: 'Processing was cancelled by the user.' });
        break;
      }
      batchProgress.value = { ...batchProgress.value, currentFile: fileHandle.name };
      try {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        const { processWorker } = await import('../../../core/workers');
        const { hasWatermarkContent, hasHeaderFooterContent } = await import('../watermark/state');

        let currentBytes = bytes;

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
            if (!report.alreadyOptimized) {
              const res = await compressDocument(currentBytes, compress, report);
              if (!res.keptOriginal) {
                currentBytes = res.bytes;
              }
            }
          }
        }

        // Save output — safe because we verified inDir !== outDir above.
        // BAT-03: use the pre-resolved output name for this file.
        const outName = resolvedNames[fileIndex] + '.pdf';
        const outHandle = await outDir.getFileHandle(outName, { create: true });
        const writable = await outHandle.createWritable();
        try {
          await writable.write(currentBytes);
          await writable.close();
        } catch (writeErr) {
          await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
          throw writeErr;
        }

        batchProgress.value = {
          ...batchProgress.value,
          completed: batchProgress.value.completed + 1
        };
      } catch (err) {
        console.error(`Failed to process ${fileHandle.name}`, err);
        notify('danger', `Failed to process ${fileHandle.name}`, {
          detail: err instanceof Error ? err.message : String(err)
        });
        batchProgress.value = { ...batchProgress.value, failed: batchProgress.value.failed + 1 };
      }
    }

    notify('success', 'Batch Processing Complete', {
      detail: `Successfully processed ${batchProgress.value.completed} files. ${batchProgress.value.failed} failed.`
    });
  } catch (err) {
    console.error(err);
    notify('danger', 'Batch Processing Failed', { detail: String(err) });
  } finally {
    batchProgress.value = { ...batchProgress.value, isProcessing: false };
  }
}
