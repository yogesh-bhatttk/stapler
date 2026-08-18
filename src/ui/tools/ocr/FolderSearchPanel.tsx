/**
 * OCR-02 — Folder Search UI Component.
 *
 * Allows folder selection, displays indexing progress bar, search input field,
 * and search result list with snippet matching, page number attribution, and jump-to-page.
 */
import { useState } from 'preact/hooks';
import { Field, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { useTranslation } from '../../../core/i18n';
import { showDirectoryPicker } from '../../../platform/fsa';
import {
  indexDirectory,
  searchFolderIndex,
  type FolderIndexStats,
  type SearchResultItem
} from '../../../core/ocr/folder-index';
import { activeDoc, activePageIndex, addDocument, makePageRefs } from '../../../core/store';
import type { FsaDirectoryHandle } from '../../../platform/fsa';

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

  const handleSelectFolder = async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'read' });
      if (handle) {
        setDirHandle(handle);
        setStatusText('Folder selected: ' + handle.name);
      }
    } catch {
      // User cancelled picker
    }
  };

  const handleStartIndexing = async () => {
    if (!dirHandle) return;
    setIndexing(true);
    setProgress(0);
    setStatusText('Starting index...');
    try {
      const resStats = await indexDirectory(dirHandle, {
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
      setStatusText('Indexing error: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIndexing(false);
    }
  };

  const handleSearch = async (val: string) => {
    setQuery(val);
    if (!val.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await searchFolderIndex(val);
      setResults(res);
    } finally {
      setSearching(false);
    }
  };

  const handleJumpToPage = async (item: SearchResultItem) => {
    const currentDoc = activeDoc.value;
    if (currentDoc && (currentDoc.name === item.fileName || currentDoc.id === item.fileId)) {
      activePageIndex.value = item.pageIndex;
      return;
    }

    if (item.handle) {
      try {
        await item.handle.getFile();
        addDocument({
          id: crypto.randomUUID(),
          name: item.fileName,
          pages: makePageRefs(crypto.randomUUID(), 1),
          annotations: [],
          dirty: false
        });
        activePageIndex.value = item.pageIndex;
      } catch {
        activePageIndex.value = item.pageIndex;
      }
    } else {
      activePageIndex.value = item.pageIndex;
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
          {t(
            'Indexed ' +
              stats.filesIndexed +
              ' PDFs (' +
              stats.pagesIndexed +
              ' pages, ' +
              stats.totalTokens +
              ' tokens) in ' +
              stats.durationMs +
              'ms.'
          )}
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
            {results.length} {t('results found:')}
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
                    {t('Page')} {res.pageNumber}
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
