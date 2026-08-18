import { translate } from '../i18n';
/**
 * OCR-02 — Folder Index and Search.
 *
 * Indexes a directory of PDFs (text layer, OCR scans on demand); inverted index
 * stored in IndexedDB (`searchIndex` store); fast queries (<500ms) with snippets,
 * page numbers, and jump-to-page capability. Incremental re-index on change.
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
import { fromUnknown, logEvent } from '../errors';
import { notify } from '../notify';
import { createJobHandle } from '../workers/protocol';
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
}

export interface FolderIndexOptions {
  onProgress?: (progress: number, label: string) => void;
  signal?: AbortSignal;
  forceReindex?: boolean;
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
  options?.onProgress?.(0, 'Scanning directory for PDFs...');

  const pdfFiles = await collectPdfFilesFromDir(dirHandle);

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

  for (let i = 0; i < pdfFiles.length; i++) {
    if (options?.signal?.aborted) {
      throw new Error('Indexing operation aborted');
    }

    const { fileId, fileName, handle, file } = pdfFiles[i];
    const progressFrac = (i + 1) / (pdfFiles.length || 1);
    options?.onProgress?.(progressFrac, `Indexing ${fileName} (${i + 1}/${pdfFiles.length})`);

    // Incremental check
    const docKey = `doc:${fileId}`;
    const existingMeta = await getSearchIndexRecord(docKey);
    if (
      !options?.forceReindex &&
      existingMeta &&
      existingMeta.lastModified === file.lastModified &&
      existingMeta.size === file.size
    ) {
      // Skipped unchanged file
      continue;
    }

    // Clear old tokens for this file before re-indexing
    await deleteSearchIndexRecordsByFileId(fileId);
    rewrittenFileIds.add(fileId);

    const fileBaseFrac = i / (pdfFiles.length || 1);
    const fileWeight = 1 / (pdfFiles.length || 1);

    const { pages: pagesText, skipReason } = await readPdfTextPages(file, {
      signal: options?.signal,
      onProgress: (localFrac, localLabel) => {
        options?.onProgress?.(
          fileBaseFrac + fileWeight * (localFrac ?? 0),
          `Indexing ${fileName} (${i + 1}/${pdfFiles.length})${localLabel ? ` — ${localLabel}` : ''}`
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

    filesIndexed++;
    pagesIndexed += pagesText.length;

    for (let pageIndex = 0; pageIndex < pagesText.length; pageIndex++) {
      const pageText = pagesText[pageIndex];
      const tokens = tokenizeText(pageText);

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
            textSnippet: snippet
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
      indexedAt: Date.now()
    });
  }

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

  const durationMs = Math.round(performance.now() - startTime);
  options?.onProgress?.(1, `Indexed ${filesIndexed} PDFs in ${durationMs}ms`);

  if (skipped.length > 0) {
    // Surfaced, not swallowed: a file missing from search results is invisible
    // unless we say so. One toast for the run, naming the files.
    const names = skipped.map(s => s.fileName);
    notify('warning', translate(`${skipped.length} file(s) could not be indexed`), {
      detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names.length - 3} more` : ''} — ${skipped[0].reason} These files will not appear in search results.`
    });
    for (const entry of skipped) {
      logEvent('warn', 'folder-index', `${entry.fileId}: ${entry.reason}`);
    }
  }

  return {
    filesIndexed,
    pagesIndexed,
    totalTokens: totalTokensCount,
    durationMs,
    skipped
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
    score
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
