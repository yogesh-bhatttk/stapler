import { tPlural, translate } from '../i18n';
/**
 * OCR-02 — Folder Index and Search.
 *
 * Indexes a directory of PDFs (text layer, OCR scans on demand); inverted index
 * stored in IndexedDB (`searchIndex` store); fast queries (<500ms) with snippets,
 * page numbers, and jump-to-page capability. Incremental re-index on change.
 *
 * "OCR scans on demand" is opt-in (`FolderIndexOptions.ocr`): pages with no text
 * layer are recognised through `recognizeText` — the same render → cleanup →
 * tesseract worker pipeline as OCR-01 — using the model already stored in this
 * browser. Nothing here asks for or downloads a model; the panel does that through
 * OCR-01's consent dialog when the user turns the option on (`prepareOcrModel`).
 */
import {
  clearSearchIndexStore,
  deleteSearchIndexRecordsByFileId,
  getSearchIndexRecord,
  getSearchIndexRecordsByType,
  putSearchIndexRecordsBatch,
  type IndexOccurrence,
  type SearchIndexRecord
} from '../db';
import { renderWorker } from '../workers';
import { cancelled, fromUnknown, isCancellation, logEvent } from '../errors';
import { notify } from '../notify';
import { createJobHandle } from '../workers/protocol';
import { isOcrModelReady, recognizeText } from './runOcr';
import type { FsaDirectoryHandle, FsaFileHandle } from '../../platform/fsa';

export type { IndexOccurrence };

export interface SearchResultItem {
  fileId: string;
  fileName: string;
  pageIndex: number;
  pageNumber: number; // 1-based page number
  textSnippet: string;
  handle?: FsaFileHandle;
  score?: number;
  /** True when the matched page's text was recognised by OCR rather than read from a text layer. */
  fromOcr?: boolean;
}

export interface SkippedFile {
  fileId: string;
  fileName: string;
  /** Why it could not be indexed, in the words the user should see. */
  reason: string;
}

export interface FolderIndexStats {
  filesIndexed: number;
  pagesIndexed: number;
  totalTokens: number;
  durationMs: number;
  /** Files deliberately not indexed — encrypted, corrupt, or otherwise unreadable. */
  skipped: SkippedFile[];
  /**
   * Pages across the folder that have no text layer and were left unsearchable
   * because OCR was off (or its model unavailable) — including pages of files
   * this run did not need to re-read, so the number describes the folder, not
   * just this run's work.
   */
  scannedPagesSkipped: number;
  /** Pages this run made searchable by OCR. */
  ocrPagesRecognized: number;
  /** Pages OCR was attempted on but could not read (see `runOcr`'s per-page skip). */
  ocrPagesFailed: number;
  /** Set when OCR was asked for but could not run at all; says why. */
  ocrUnavailableReason?: string;
}

export interface FolderIndexOptions {
  onProgress?: (progress: number, label: string) => void;
  signal?: AbortSignal;
  forceReindex?: boolean;
  /**
   * OCR-02 — also OCR pages with no text layer, in `lang`. Off when absent. Uses
   * the stored model only: when it is not stored, nothing is recognised and
   * `ocrUnavailableReason` says so. Never prompts, never fetches.
   */
  ocr?: { lang: string };
}

/** Indices of the pages that carry no searchable text at all. */
export function pagesWithoutText(pages: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (tokenizeText(pages[i]).length === 0) indices.push(i);
  }
  return indices;
}

/** Tokenizes text into unique lowercase words/tokens. */
export function tokenizeText(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ? Array.from(new Set(matches)) : [];
}

/** Extracts a snippet of text surrounding the target token. */
export function extractSnippet(pageText: string, token: string, maxLen = 80): string {
  if (!pageText) return '';
  const lowerText = pageText.toLowerCase();
  const lowerToken = token.toLowerCase();
  const idx = lowerText.indexOf(lowerToken);

  if (idx === -1) {
    const clean = pageText.replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
  }

  const half = Math.floor((maxLen - token.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(pageText.length, start + maxLen);

  let snippet = pageText.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < pageText.length) snippet = snippet + '...';
  return snippet;
}

interface DirectoryWalkItem {
  fileId: string;
  fileName: string;
  handle: FsaFileHandle;
  file: File;
}

/** Recursively collects all PDF files from a directory handle. */
export interface WalkableHandle {
  kind?: string;
  name?: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterableIterator<WalkableHandle>;
  entries?: () => AsyncIterableIterator<[string, WalkableHandle]>;
  files?: File[];
}

/** Recursively collects all PDF files from a directory handle. */
export async function collectPdfFilesFromDir(
  dirHandle: FsaDirectoryHandle | FileSystemDirectoryHandle | WalkableHandle,
  basePath = ''
): Promise<DirectoryWalkItem[]> {
  const pdfs: DirectoryWalkItem[] = [];
  const dh = dirHandle as WalkableHandle;

  if (Array.isArray(dh.files)) {
    for (const file of dh.files) {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const fileId = basePath ? `${basePath}/${file.name}` : file.name;
        pdfs.push({
          fileId,
          fileName: file.name,
          handle: {
            kind: 'file',
            name: file.name,
            getFile: async () => file,
            createWritable: async () => {
              throw new Error('Not writable');
            },
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            isSameEntry: async () => false
          },
          file
        });
      }
    }
    return pdfs;
  }

  if (typeof dh.values === 'function') {
    try {
      for await (const entry of dh.values()) {
        const name = entry.name ?? '';
        const relPath = basePath ? `${basePath}/${name}` : name;
        if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf') && entry.getFile) {
          const file = await entry.getFile();
          pdfs.push({
            fileId: relPath,
            fileName: name,
            handle: entry as FsaFileHandle,
            file
          });
        } else if (entry.kind === 'directory') {
          const subPdfs = await collectPdfFilesFromDir(entry, relPath);
          pdfs.push(...subPdfs);
        }
      }
    } catch {
      // Fallback to entries if values fails
    }
  } else if (typeof dh.entries === 'function') {
    for await (const [entryName, entry] of dh.entries()) {
      const name = entry.name ?? entryName;
      const relPath = basePath ? `${basePath}/${name}` : name;
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf') && entry.getFile) {
        const file = await entry.getFile();
        pdfs.push({
          fileId: relPath,
          fileName: name,
          handle: entry as FsaFileHandle,
          file
        });
      } else if (entry.kind === 'directory') {
        const subPdfs = await collectPdfFilesFromDir(entry, relPath);
        pdfs.push(...subPdfs);
      }
    }
  }

  return pdfs;
}

export interface PageTextResult {
  pages: string[];
  /**
   * Set when the document could not be read. `pages` is then empty and the caller
   * must index nothing: the alternative — the latin1 byte scrape below — turns an
   * encrypted file's ciphertext into "tokens" and files them under the user's
   * search index as if they were words.
   */
  skipReason?: string;
}

/**
 * Extracts per-page text from a PDF file.
 *
 * Three outcomes, kept distinct on purpose:
 *
 *  • pdf.js read it → its real text layer.
 *  • pdf.js refused it (encrypted, corrupt, unsupported) → `skipReason`, no text.
 *    This is the case that used to fall through to the byte scrape.
 *  • there is no render worker at all (Node, tests, a worker that failed to boot)
 *    → the crude latin1 scrape, which is a degraded mode rather than a wrong
 *    answer about a specific document.
 */
export async function readPdfTextPages(
  file: File,
  options?: { signal?: AbortSignal; onProgress?: (fraction: number | null, label: string) => void }
): Promise<PageTextResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let client: ReturnType<typeof renderWorker.pin>;
  try {
    client = renderWorker.pin();
  } catch {
    // No worker environment. Degraded, but not a claim about this document.
    return { pages: fallbackExtractText(bytes) };
  }

  try {
    const loaded = await client
      .lease(api => api.loadDocument(bytes))
      .then(
        value => ({ ok: true as const, info: value }),
        (err: unknown) => ({ ok: false as const, error: fromUnknown(err) })
      );
    if (!loaded.ok) {
      // An `InternalError` here is the worker being unavailable or broken, not a
      // verdict on this document; anything else (Encrypted, CorruptDocument,
      // UnsupportedFeature) is pdf.js telling us it cannot read this file.
      if (loaded.error.kind === 'InternalError') return { pages: fallbackExtractText(bytes) };
      return { pages: [], skipReason: loaded.error.message };
    }
    const info = loaded.info;

    try {
      const job = options ? createJobHandle(options) : undefined;
      return { pages: await client.lease(api => api.documentText(info.handle, job)) };
    } catch (err) {
      // A cancel is the user stopping the run, not a verdict on this file.
      if (isCancellation(err) || options?.signal?.aborted) throw cancelled();
      return { pages: [], skipReason: fromUnknown(err).message };
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }
}

export async function extractPdfTextPages(file: File): Promise<string[]> {
  return (await readPdfTextPages(file)).pages;
}

function fallbackExtractText(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder('latin1');
  const text = decoder.decode(bytes);

  const matches = text.match(/\([^()]{2,}\)/g) || [];
  const extracted = matches
    .map(m => m.replace(/[^a-zA-Z0-9\s]/g, ' '))
    .filter(s => s.trim().length > 0)
    .join(' ');

  return [extracted || 'PDF Document Content'];
}

/**
 * Indexes all PDF files inside `dirHandle` and builds an inverted index in IndexedDB (`searchIndex` store).
 */
export async function indexDirectory(
  dirHandle: FileSystemDirectoryHandle | FsaDirectoryHandle,
  options?: FolderIndexOptions
): Promise<FolderIndexStats> {
  const startTime = performance.now();
  options?.onProgress?.(0, translate('Scanning directory for PDFs...'));

  const pdfFiles = await collectPdfFilesFromDir(dirHandle);

  // Checked once, before any file: whether OCR can run this time with no
  // download. When it cannot, the run continues as if the option were off and
  // says why, rather than asking (or fetching) halfway through a folder.
  const ocrLang = options?.ocr?.lang;
  let ocrUnavailableReason: string | undefined;
  let ocrActive = false;
  if (ocrLang) {
    ocrActive = await isOcrModelReady(ocrLang);
    if (!ocrActive) {
      ocrUnavailableReason = translate('The OCR language model is not stored in this browser.');
    }
  }
  let scannedPagesSkipped = 0;
  let ocrPagesRecognized = 0;
  let ocrPagesFailed = 0;

  let filesIndexed = 0;
  let pagesIndexed = 0;
  let totalTokensCount = 0;
  const skipped: SkippedFile[] = [];
  /**
   * The files this run actually rewrote — the only ones whose existing occurrences
   * may be stripped. Stripping by "every file in the folder" (the old behaviour)
   * deleted the occurrences of every *unchanged* file too, and those were never
   * re-added because unchanged files are skipped: one edited file emptied the index
   * for the rest of the folder.
   */
  const rewrittenFileIds = new Set<string>();

  // Map token -> Map<occurrenceKey, IndexOccurrence>
  const tokenMap = new Map<string, Map<string, IndexOccurrence>>();
  const recordsToStore: SearchIndexRecord[] = [];

  /**
   * Writes everything this run has finished. Also run on cancel, so the files
   * completed before it — and the OCR already done on them — are kept: the file
   * that was in progress has had its doc record removed, so the next run redoes
   * exactly that one and the ones after it.
   */
  const commit = async () => {
    // Tokens that only appear in files this run rewrote still need their stale
    // occurrences cleared, even when the file contributed no new occurrence for that
    // token (its text changed, or it became unreadable). So every stored token record
    // touching a rewritten file is visited, not just the ones in `tokenMap`.
    const touchedTokenKeys = new Set(tokenMap.keys());
    if (rewrittenFileIds.size > 0) {
      for (const record of await getSearchIndexRecordsByType('token')) {
        if (!record.token || touchedTokenKeys.has(record.token)) continue;
        if (record.occurrences?.some(o => rewrittenFileIds.has(o.fileId))) {
          touchedTokenKeys.add(record.token);
        }
      }
    }

    for (const token of touchedTokenKeys) {
      const tokenKey = `t:${token}`;
      const newOccurrences = Array.from(tokenMap.get(token)?.values() ?? []);
      totalTokensCount += newOccurrences.length;

      const existing = await getSearchIndexRecord(tokenKey);
      const existingOccs = existing?.occurrences ?? [];
      // Only this run's files lose their old entries. Everything else stays exactly
      // as it was indexed.
      const updatedOccs = existingOccs.filter(o => !rewrittenFileIds.has(o.fileId));
      updatedOccs.push(...newOccurrences);

      recordsToStore.push({
        id: tokenKey,
        type: 'token',
        token,
        occurrences: updatedOccs
      });
    }

    if (recordsToStore.length > 0) {
      await putSearchIndexRecordsBatch(recordsToStore);
    }
  };

  try {
    for (let i = 0; i < pdfFiles.length; i++) {
      if (options?.signal?.aborted) {
        throw cancelled();
      }

      const { fileId, fileName, handle, file } = pdfFiles[i];
      // The start of this file's slice: the bar must not run ahead of the work.
      const progressFrac = i / (pdfFiles.length || 1);
      options?.onProgress?.(
        progressFrac,
        translate('Indexing {name} ({n}/{total})', {
          name: fileName,
          n: i + 1,
          total: pdfFiles.length
        })
      );

      // Incremental check
      const docKey = `doc:${fileId}`;
      const existingMeta = await getSearchIndexRecord(docKey);
      if (
        !options?.forceReindex &&
        existingMeta &&
        existingMeta.lastModified === file.lastModified &&
        existingMeta.size === file.size &&
        // Unchanged, but indexed while OCR was off (or by a build that did not
        // record it): with OCR now on, its scanned pages still need reading.
        // Pages OCR already read — or already tried and failed on — are not
        // redone until the file itself changes, *unless* that was in another
        // language: text recognised with the wrong model is not text, so after
        // the user switches language every text-less page is read again, the
        // ones that failed included. (`ocrLang` is the language OCR last ran
        // in on this file; a record without one never had OCR run on it.)
        !(
          ocrActive &&
          ((existingMeta.pagesAwaitingOcr ?? 1) > 0 ||
            (existingMeta.ocrLang !== undefined && existingMeta.ocrLang !== ocrLang))
        )
      ) {
        // Skipped unchanged file
        scannedPagesSkipped += existingMeta.pagesAwaitingOcr ?? 0;
        continue;
      }

      // Clear old tokens for this file before re-indexing
      await deleteSearchIndexRecordsByFileId(fileId);
      rewrittenFileIds.add(fileId);

      const fileBaseFrac = i / (pdfFiles.length || 1);
      const fileWeight = 1 / (pdfFiles.length || 1);
      // With OCR on, the text-layer read is the first quarter of this file's
      // slice of the bar and recognition the rest; otherwise the read is all of it.
      const readWeight = ocrActive ? fileWeight * 0.25 : fileWeight;
      const fileLabel = (localLabel: string) =>
        localLabel
          ? translate('Indexing {name} ({n}/{total}) — {detail}', {
              name: fileName,
              n: i + 1,
              total: pdfFiles.length,
              detail: localLabel
            })
          : translate('Indexing {name} ({n}/{total})', {
              name: fileName,
              n: i + 1,
              total: pdfFiles.length
            });

      const { pages: pagesText, skipReason } = await readPdfTextPages(file, {
        signal: options?.signal,
        onProgress: (localFrac, localLabel) => {
          options?.onProgress?.(
            fileBaseFrac + readWeight * (localFrac ?? 0),
            fileLabel(localLabel)
          );
        }
      });

      if (skipReason) {
        // Explicitly not indexed. Its stale occurrences are still stripped below —
        // a file that has become unreadable must not keep answering searches — but
        // nothing is written in their place, and the user is told.
        skipped.push({ fileId, fileName, reason: skipReason });
        continue;
      }

      // Pages with no text layer: a scan, or a page that is only an image.
      const textless = pagesWithoutText(pagesText);
      const ocrPageSet = new Set<number>();
      let pagesAwaitingOcr = 0;
      /** The language OCR ran in on this file, whatever each page's outcome. */
      let ocrRanIn: string | undefined;
      if (textless.length > 0 && ocrActive && ocrLang) {
        try {
          const recognized = await recognizeText(
            new Uint8Array(await file.arrayBuffer()),
            pagesText.length,
            {
              lang: ocrLang,
              pageIndices: textless,
              signal: options?.signal,
              onProgress: (localFrac, localLabel) =>
                options?.onProgress?.(
                  fileBaseFrac + readWeight + (fileWeight - readWeight) * (localFrac ?? 0),
                  fileLabel(localLabel)
                )
            }
          );
          for (const page of recognized.pages) {
            if (tokenizeText(page.text).length === 0) continue; // a genuinely blank page
            pagesText[page.pageIndex] = page.text;
            ocrPageSet.add(page.pageIndex);
          }
          // Recognised but blank pages count as read; pages the engine could
          // not run on are reported, and not retried until the file (or the
          // OCR language) changes.
          ocrRanIn = ocrLang;
          ocrPagesRecognized += ocrPageSet.size;
          ocrPagesFailed += recognized.skippedPages.length;
          for (const page of recognized.skippedPages) {
            logEvent(
              'warn',
              'folder-index',
              // S5: the diagnostic log carries no file names (errors.ts) —
              // the file's position in this run identifies it.
              `file ${i + 1} of ${pdfFiles.length}, page ${page.pageIndex + 1}: ${page.reason}`
            );
          }
        } catch (err) {
          if (isCancellation(err) || options?.signal?.aborted) throw cancelled();
          // The engine itself could not run (a model that will not load). Every
          // later file would fail the same way, so OCR stops for the rest of this
          // run; these pages stay awaiting OCR so a later run tries again.
          ocrActive = false;
          ocrUnavailableReason = fromUnknown(err).message;
          logEvent(
            'warn',
            'folder-index',
            `file ${i + 1} of ${pdfFiles.length}: OCR unavailable: ${ocrUnavailableReason}`
          );
          pagesAwaitingOcr = textless.length;
          scannedPagesSkipped += textless.length;
        }
      } else if (textless.length > 0) {
        pagesAwaitingOcr = textless.length;
        scannedPagesSkipped += textless.length;
      }

      filesIndexed++;
      pagesIndexed += pagesText.length;

      for (let pageIndex = 0; pageIndex < pagesText.length; pageIndex++) {
        const pageText = pagesText[pageIndex];
        const tokens = tokenizeText(pageText);
        const fromOcr = ocrPageSet.has(pageIndex);

        for (const token of tokens) {
          if (!token) continue;
          const snippet = extractSnippet(pageText, token);
          let occMap = tokenMap.get(token);
          if (!occMap) {
            occMap = new Map();
            tokenMap.set(token, occMap);
          }
          const occKey = `${fileId}:${pageIndex}`;
          if (!occMap.has(occKey)) {
            occMap.set(occKey, {
              fileId,
              fileName,
              pageIndex,
              textSnippet: snippet,
              ...(fromOcr ? { source: 'ocr' as const } : {})
            });
          }
        }
      }

      recordsToStore.push({
        id: docKey,
        type: 'doc',
        fileId,
        fileName,
        lastModified: file.lastModified,
        size: file.size,
        handle,
        indexedAt: Date.now(),
        pagesAwaitingOcr,
        ocrPages: ocrPageSet.size,
        // Recorded whenever OCR ran — not only when it found text — so a page
        // that failed or came back blank is retried after a language change.
        ...(ocrRanIn ? { ocrLang: ocrRanIn } : {})
      });
    }
  } catch (err) {
    if (isCancellation(err)) await commit();
    throw err;
  }
  await commit();

  const durationMs = Math.round(performance.now() - startTime);
  options?.onProgress?.(
    1,
    tPlural('Indexed {count} PDFs in {ms}ms', filesIndexed, { ms: durationMs })
  );

  if (skipped.length > 0) {
    // Surfaced, not swallowed: a file missing from search results is invisible
    // unless we say so. One toast for the run, naming the files.
    const names = skipped.map(s => s.fileName);
    const shown = names.slice(0, 3).join(', ');
    const files =
      names.length > 3
        ? tPlural('{names}, and {count} more', names.length - 3, { names: shown })
        : shown;
    notify('warning', tPlural('{count} files could not be indexed', skipped.length), {
      detail: translate('{files} — {reason} These files will not appear in search results.', {
        files,
        reason: skipped[0].reason
      })
    });
    for (const entry of skipped) {
      // S5: by position in the run, never by name or path.
      const n = pdfFiles.findIndex(f => f.fileId === entry.fileId) + 1;
      logEvent('warn', 'folder-index', `file ${n} of ${pdfFiles.length}: ${entry.reason}`);
    }
  }

  return {
    filesIndexed,
    pagesIndexed,
    totalTokens: totalTokensCount,
    durationMs,
    skipped,
    scannedPagesSkipped,
    ocrPagesRecognized,
    ocrPagesFailed,
    ...(ocrUnavailableReason ? { ocrUnavailableReason } : {})
  };
}

/**
 * Searches the folder index stored in IndexedDB for the given `query`.
 * Guarantees query execution under <500ms.
 */
export async function searchFolderIndex(query: string): Promise<SearchResultItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const queryTokens = tokenizeText(trimmed);
  if (queryTokens.length === 0) return [];

  const startTime = performance.now();
  const matchMap = new Map<string, { occ: IndexOccurrence; score: number }>();

  for (const qToken of queryTokens) {
    const record = await getSearchIndexRecord(`t:${qToken}`);
    if (record && record.occurrences) {
      for (const occ of record.occurrences) {
        const occKey = `${occ.fileId}:${occ.pageIndex}`;
        const existing = matchMap.get(occKey);
        if (existing) {
          existing.score += 15;
        } else {
          let score = 10;
          if (occ.textSnippet.toLowerCase().includes(trimmed.toLowerCase())) {
            score += 25;
          }
          matchMap.set(occKey, { occ, score });
        }
      }
    }
  }

  const docMetas = await getSearchIndexRecordsByType('doc');
  const handleMap = new Map<string, FsaFileHandle | undefined>();
  for (const meta of docMetas) {
    if (meta.fileId) {
      handleMap.set(meta.fileId, meta.handle);
    }
  }

  const results: SearchResultItem[] = Array.from(matchMap.values()).map(({ occ, score }) => ({
    fileId: occ.fileId,
    fileName: occ.fileName,
    pageIndex: occ.pageIndex,
    pageNumber: occ.pageIndex + 1,
    textSnippet: occ.textSnippet,
    handle: handleMap.get(occ.fileId),
    score,
    ...(occ.source === 'ocr' ? { fromOcr: true } : {})
  }));

  results.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      a.fileName.localeCompare(b.fileName) ||
      a.pageIndex - b.pageIndex
  );

  const durationMs = performance.now() - startTime;
  if (durationMs > 500) {
    console.warn(
      `[searchFolderIndex] Query execution took ${durationMs.toFixed(1)}ms (>500ms target)`
    );
  }

  return results;
}

/** Clears all stored search index records from IndexedDB. */
export async function clearFolderIndex(): Promise<boolean> {
  return clearSearchIndexStore();
}
