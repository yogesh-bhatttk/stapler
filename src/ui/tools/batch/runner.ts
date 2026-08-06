import {
  batchProgress,
  inputDirHandle,
  outputDirHandle,
  activeRecipeId,
  savedRecipes
} from './state';
import { compressSettings } from '../compress/state';
import { watermarkSettings, headerFooterSettings } from '../watermark/state';
import { nupSettings } from '../nup/state';
import { normalizeSettings } from '../normalize/state';
import { compressDocument, planCompression } from '../../../core/operations';
import type { WatermarkData } from '../../../core/workers/process.worker';
import { notify } from '../../../core/notify';

export async function runBatch() {
  const inDir = inputDirHandle.value;
  const outDir = outputDirHandle.value;
  if (!inDir || !outDir) return;

  // Safety: if the input and output directory are the same filesystem entry,
  // a batch run would overwrite the source files in-place with no backup —
  // the output handle is opened with { create: true } using the same filename,
  // silently destroying the original. Reject upfront with a clear message.
  if (await inDir.isSameEntry(outDir)) {
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

  const compress = recipe?.settings.compress ?? compressSettings.value;
  const watermark = recipe?.settings.watermark ?? watermarkSettings.value;
  const headerFooter = recipe?.settings.headerFooter ?? headerFooterSettings.value;
  const nup = recipe?.settings.nup ?? nupSettings.value;
  const normalize = recipe?.settings.normalize ?? normalizeSettings.value;

  batchProgress.value = {
    total: 0,
    completed: 0,
    failed: 0,
    currentFile: '',
    isProcessing: true
  };

  try {
    const files: FileSystemFileHandle[] = [];
    // @ts-expect-error TODO: fix type
    for await (const entry of inDir.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
        files.push(entry);
      }
    }

    batchProgress.value = { ...batchProgress.value, total: files.length };

    for (const fileHandle of files) {
      batchProgress.value = { ...batchProgress.value, currentFile: fileHandle.name };
      try {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Load WITHOUT ignoreEncryption so encrypted files surface as an error
        // rather than silently producing garbled output. The previous code used
        // `ignoreEncryption: true`, which caused compose to write empty or
        // corrupted pages for password-protected files without any warning.
        const { PDFDocument } = await import('pdf-lib');
        let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
        try {
          doc = await PDFDocument.load(bytes);
        } catch (loadErr) {
          const msg = String(loadErr);
          const isEncrypted = msg.toLowerCase().includes('encrypt') || msg.includes('password');
          if (isEncrypted) {
            throw new Error(`${fileHandle.name} is password-protected — skipping.`, {
              cause: loadErr
            });
          }
          throw loadErr;
        }
        const pageCount = doc.getPageCount();

        const pages = Array.from({ length: pageCount }).map((_, i) => ({
          key: `${fileHandle.name}-${i}`,
          sourceDocId: fileHandle.name,
          sourceIndex: i,
          rotation: 0
        }));

        const { processWorker } = await import('../../../core/workers');
        const { hasWatermarkContent } = await import('../watermark/state');
        const { hasHeaderFooterContent } = await import('../watermark/state');

        let currentBytes = bytes;

        // Apply tools in the order declared by recipe.tools (or defaults).
        // Previously every tool was always applied in a hardcoded compose→compress
        // sequence, ignoring recipe.tools entirely.
        for (const toolId of activeTools) {
          if (toolId === 'watermark') {
            // Watermark and header/footer share the compose call.
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
                  undefined, // normalize — handled separately
                  undefined, // nup — handled separately
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
          } else if (toolId === 'compress' && compress) {
            const report = await planCompression(currentBytes, compress);
            if (!report.alreadyOptimized) {
              const res = await compressDocument(currentBytes, compress, report);
              if (!res.keptOriginal) {
                currentBytes = res.bytes;
              }
            }
          }
          // Other tool IDs (redact, sign, etc.) are not batch-applicable yet
          // and are silently skipped — the recipe will still apply whatever
          // tools it does support.
        }

        // Save output — safe because we verified inDir !== outDir above.
        const outHandle = await outDir.getFileHandle(fileHandle.name, { create: true });
        const writable = await outHandle.createWritable();
        await writable.write(currentBytes);
        await writable.close();

        batchProgress.value = {
          ...batchProgress.value,
          completed: batchProgress.value.completed + 1
        };
      } catch (err) {
        console.error(`Failed to process ${fileHandle.name}`, err);
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
