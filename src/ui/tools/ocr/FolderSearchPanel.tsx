/**
 * OCR-02 — Folder Search UI Component.
 *
 * Allows folder selection, displays indexing progress bar, search input field,
 * and search result list with snippet matching, page number attribution, and jump-to-page.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { Field, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { tPlural, useTranslation } from '../../../core/i18n';
import { showDirectoryPicker } from '../../../platform/fsa';
import {
  indexDirectory,
  searchFolderIndex,
  type FolderIndexStats,
  type SearchResultItem
} from '../../../core/ocr/folder-index';
import { activePageIndex, documents, switchDocument } from '../../../core/store';
import { importFilesAsDocuments } from '../../../core/open-document';
import { notifyError } from '../../../core/notify';
import type { FsaDirectoryHandle } from '../../../platform/fsa';

/** Folder-relative path → the document it was opened as, so a second result doesn't open it twice. */
const openedFromFolder = new Map<string, string>();

export function FolderSearchPanel() {
  const t = useTranslation();
  const [dirHandle, setDirHandle] = useState<FsaDirectoryHandle | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [stats, setStats] = useState<FolderIndexStats | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  // Each keystroke starts a new lookup with no cancellation and no guarantee
  // it resolves in order — a fast type-then-backspace can let an earlier
  // (longer) query's results land after a shorter one's, overwriting what's
  // shown for the query currently in the box. Same bug class 6bab634 fixed
  // for the Sign panel's fetch race; the fix here is the same shape: only the
  // most recently started search is allowed to write its result.
  const searchSeq = useRef(0);

  const handleSelectFolder = async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'read' });
      if (handle) {
        // Paths are relative to the picked folder: a second folder's
        // `report.pdf` is a different file (regression review R-UI-5).
        openedFromFolder.clear();
        setDirHandle(handle);
        setStatusText(t('Folder selected: {name}', { name: handle.name }));
      }
    } catch {
      // User cancelled picker
    }
  };

  // Indexing a large folder takes minutes. It had no way to stop, and kept
  // running (and calling setState) after the panel unmounted (AUDIT UI-24).
  const indexController = useRef<AbortController | null>(null);
  useEffect(() => () => indexController.current?.abort(), []);

  const handleStartIndexing = async () => {
    if (!dirHandle || indexController.current) return;
    const controller = new AbortController();
    indexController.current = controller;
    setIndexing(true);
    setProgress(0);
    setStatusText(t('Starting index...'));
    try {
      const resStats = await indexDirectory(dirHandle, {
        signal: controller.signal,
        onProgress: (p, label) => {
          setProgress(Math.round(p * 100));
          setStatusText(label);
        }
      });
      setStats(resStats);
      if (query.trim()) {
        await handleSearch(query);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setStatusText(t('Indexing cancelled.'));
      } else {
        setStatusText(
          t('Indexing error: {message}', {
            message: err instanceof Error ? err.message : String(err)
          })
        );
      }
    } finally {
      indexController.current = null;
      setIndexing(false);
    }
  };

  const handleSearch = async (val: string) => {
    setQuery(val);
    if (!val.trim()) {
      // An empty query has no lookup to race, but it still has to win against
      // one already in flight — otherwise that older search's results can
      // land after the box has been cleared.
      searchSeq.current += 1;
      setResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const res = await searchFolderIndex(val);
      if (seq !== searchSeq.current) return; // a newer search has since started
      setResults(res);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const handleJumpToPage = async (item: SearchResultItem) => {
    const jump = (docId: string) => {
      const doc = documents.value.find(d => d.id === docId);
      if (!doc) return false;
      switchDocument(docId);
      activePageIndex.value = Math.max(0, Math.min(item.pageIndex, doc.pages.length - 1));
      return true;
    };

    // Matched by the result's folder-relative path, never by file name: two
    // files called `report.pdf` in different subfolders are different files.
    const openedAs = openedFromFolder.get(item.fileId);
    if (openedAs && jump(openedAs)) return;
    if (!item.handle) return;

    // Imported for real. This used to add a one-page document whose page
    // pointed at a random, never-registered source id — a tab that never
    // rendered and failed on export (AUDIT-2026-09-25 UI-4).
    try {
      const file = await item.handle.getFile();
      const before = new Set(documents.value.map(d => d.id));
      await importFilesAsDocuments([file], { requestImageOptions: async () => undefined });
      const added = documents.value.find(d => !before.has(d.id));
      if (!added) return;
      openedFromFolder.set(item.fileId, added.id);
      jump(added.id);
    } catch (err) {
      notifyError('ocr.folder-search', err);
    }
  };

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Folder Search & Index')}</h2>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleSelectFolder}
          disabled={indexing}
          style={{
            height: 'var(--control-h)',
            padding: '0 var(--space-md)',
            background: 'var(--surface-3)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--ink)',
            cursor: 'pointer',
            font: 'var(--text-small)'
          }}
        >
          {dirHandle ? dirHandle.name : t('Select Folder')}
        </button>

        {dirHandle && (
          <button
            type="button"
            onClick={handleStartIndexing}
            disabled={indexing}
            style={{
              height: 'var(--control-h)',
              padding: '0 var(--space-md)',
              background: 'var(--primary)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              color: 'var(--on-primary)',
              cursor: indexing ? 'wait' : 'pointer',
              font: 'var(--text-body-strong)'
            }}
          >
            {indexing ? t('Indexing...') : t('Index PDFs')}
          </button>
        )}
        {indexing && (
          <Button
            variant="secondary"
            size="compact"
            onClick={() => indexController.current?.abort()}
          >
            {t('Cancel')}
          </Button>
        )}
      </div>

      {indexing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div
            style={{
              height: '6px',
              width: '100%',
              background: 'var(--surface-3)',
              borderRadius: 'var(--radius-pill)',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                height: '100%',
                width: progress + '%',
                background: 'var(--primary)',
                transition: 'width 200ms ease'
              }}
            />
          </div>
          <span style={{ font: 'var(--text-micro)', color: 'var(--ink-subtle)' }}>
            {statusText || progress + '%'}
          </span>
        </div>
      )}

      {stats && !indexing && (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
          {t('Indexed {files} ({pages}, {tokens}) in {ms}ms.', {
            files: tPlural('{count} PDFs', stats.filesIndexed),
            pages: tPlural('{count} pages', stats.pagesIndexed),
            tokens: tPlural('{count} tokens', stats.totalTokens),
            ms: stats.durationMs
          })}
        </p>
      )}

      <Field label={t('Search indexed PDFs')}>
        {id => (
          <TextInput
            id={id}
            value={query}
            placeholder={t('Type search terms...')}
            onInput={e => handleSearch((e.target as HTMLInputElement).value)}
          />
        )}
      </Field>

      {searching && <p className={panelStyles.description}>{t('Searching index...')}</p>}

      {query.trim() && !searching && results.length === 0 && (
        <p className={panelStyles.description}>{t('No matches found in folder index.')}</p>
      )}

      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ font: 'var(--text-micro)', color: 'var(--ink-muted)' }}>
            {tPlural('{count} results found:', results.length)}
          </span>
          <ul className={panelStyles.list} style={{ maxHeight: '300px' }}>
            {results.map((res, i) => (
              <li
                key={res.fileId + '-' + res.pageIndex + '-' + i}
                className={panelStyles.listRow}
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  padding: '8px',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)'
                }}
                onClick={() => handleJumpToPage(res)}
              >
                <div
                  style={{
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'space-between',
                    fontWeight: 600
                  }}
                >
                  <span className={panelStyles.listRowText}>{res.fileName}</span>
                  <span
                    style={{
                      font: 'var(--text-micro)',
                      color: 'var(--primary)',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {t('Page {page}', { page: res.pageNumber })}
                  </span>
                </div>
                <div
                  style={{
                    font: 'var(--text-micro)',
                    color: 'var(--ink-subtle)',
                    marginTop: '2px',
                    wordBreak: 'break-word'
                  }}
                >
                  {res.textSnippet}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
