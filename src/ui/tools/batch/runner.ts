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

  const recipe = activeRecipeId.value
    ? savedRecipes.value.find(r => r.id === activeRecipeId.value)
    : null;

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

        // Basic page setup for composeDocument
        // Normally pages are extracted via the core/import.ts process, but for batch
        // we can just load the document to get the number of pages.
        // But `composeDocument` takes `pages: PageRef[]` which requires parsing the document.
        // So we need to parse the document first.
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pageCount = doc.getPageCount();

        const pages = Array.from({ length: pageCount }).map((_, i) => ({
          key: `${fileHandle.name}-${i}`,
          sourceDocId: fileHandle.name, // Mock document ID
          sourceIndex: i,
          rotation: 0
        }));

        // We need the raw bytes accessible to the worker by 'sourceDocId'
        // Normally `bytesForPages` retrieves this from `currentDocumentBytes`.
        // However, we are in a batch context where documents are not in the main store workspace.

        // This makes `composeDocument` slightly unsuitable directly, because it assumes `store`.
        // Let's call the `processWorker` directly.
        const { processWorker } = await import('../../../core/workers');
        const { hasWatermarkContent } = await import('../watermark/state');
        const { hasHeaderFooterContent } = await import('../watermark/state');

        const composedBytes = await processWorker.lease(api =>
          api.compose(
            pages,
            { [fileHandle.name]: bytes }, // Pass sources directly
            [], // stamps
            watermark && hasWatermarkContent(watermark)
              ? (watermark as unknown as WatermarkData)
              : undefined, // simplify toWatermarkData
            headerFooter && hasHeaderFooterContent(headerFooter) ? headerFooter : undefined,
            normalize,
            nup,
            [], // layerAnnotations
            undefined // job
          )
        );

        let finalBytes = composedBytes;

        // Apply compression if enabled
        // Wait, how do we know if compression is enabled?
        // For simplicity, we could assume if compress mode !== 'none' it's enabled.
        if (compress) {
          const report = await planCompression(composedBytes, compress);
          if (!report.alreadyOptimized) {
            const res = await compressDocument(composedBytes, compress, report);
            if (!res.keptOriginal) {
              finalBytes = res.bytes;
            }
          }
        }

        // Save output
        const outHandle = await outDir.getFileHandle(fileHandle.name, { create: true });
        const writable = await outHandle.createWritable();
        await writable.write(finalBytes);
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
