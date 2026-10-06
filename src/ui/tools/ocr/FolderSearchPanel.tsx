/**
 * OCR-02 — Folder Search UI Component.
 *
 * Allows folder selection, displays indexing progress bar, search input field,
 * and search result list with snippet matching, page number attribution, and jump-to-page.
 *
 * "Also OCR scanned pages" is off by default. Turning it on goes through OCR-01's
 * consent dialog when the language model is not stored yet (`prepareOcrModel`);
 * declining leaves it off and nothing is fetched.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { Checkbox, Field, TextInput } from '../../components/Field';
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
import { isCancellation } from '../../../core/errors';
import { prepareOcrModel } from '../../../core/ocr/runOcr';
import type { FsaDirectoryHandle } from '../../../platform/fsa';
import { ocrSettings } from './state';

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
  // OCR-02 — opt-in, off by default. `preparingModel` covers the consent
  // dialog and the model download that turning it on may start.
  const [ocrScans, setOcrScans] = useState(false);
  const [preparingModel, setPreparingModel] = useState(false);
  /** Whether the stats shown were produced with OCR on — the note's wording depends on it. */
  const [statsUsedOcr, setStatsUsedOcr] = useState(false);
  /** Why the option is off after the user tried to turn it on (declined or cancelled). */
  const [ocrMessage, setOcrMessage] = useState('');
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

  /**
   * Makes the OCR model available, through OCR-01's consent and download flow
   * when it is not stored. True when it is ready; false when the user declined
   * or cancelled (nothing was fetched in either case).
   */
  const ensureOcrModel = async (controller: AbortController): Promise<boolean> => {
    const outcome = await prepareOcrModel(ocrSettings.value.lang, {
      signal: controller.signal,
      onProgress: (p, label) => {
        if (p !== null) setProgress(Math.round(p * 100));
        setStatusText(label);
      }
    });
    if (outcome === 'declined') {
      setOcrMessage(
        t('Scanned pages will not be read: the OCR language model was not downloaded.')
      );
      return false;
    }
    return true;
  };

  const handleToggleOcr = async (checked: boolean) => {
    if (!checked) {
      setOcrScans(false);
      return;
    }
    if (indexController.current) return;
    const controller = new AbortController();
    indexController.current = controller;
    setPreparingModel(true);
    setOcrMessage('');
    setProgress(0);
    setStatusText(t('Checking the OCR language model...'));
    try {
      if (await ensureOcrModel(controller)) setOcrScans(true);
    } catch (err) {
      if (controller.signal.aborted || isCancellation(err)) {
        setOcrMessage(
          t('Scanned pages will not be read: the OCR language model was not downloaded.')
        );
      } else {
        notifyError('ocr.folder-search', err);
      }
    } finally {
      indexController.current = null;
      setPreparingModel(false);
    }
  };

  const handleStartIndexing = async () => {
    if (!dirHandle || indexController.current) return;
    const controller = new AbortController();
    indexController.current = controller;
    setIndexing(true);
    setProgress(0);
    setStatusText(t('Starting index...'));
    try {
      // The model can have been removed (or evicted) since the option was
      // turned on, or the OCR language changed: asked again, never fetched
      // without the dialog.
      let useOcr = ocrScans;
      if (useOcr && !(await ensureOcrModel(controller))) {
        useOcr = false;
        setOcrScans(false);
      }
      const resStats = await indexDirectory(dirHandle, {
        signal: controller.signal,
        ...(useOcr ? { ocr: { lang: ocrSettings.value.lang } } : {}),
        onProgress: (p, label) => {
          setProgress(Math.round(p * 100));
          setStatusText(label);
        }
      });
      setStats(resStats);
      setStatsUsedOcr(useOcr);
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
    } catch (err) {
      // Only the latest search reports: an older one failing is already superseded.
      if (seq === searchSeq.current) notifyError('ocr.folder-search', err);
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

  const busy = indexing || preparingModel;

  const ocrNotes: string[] = [];
  if (stats) {
    if (stats.ocrPagesRecognized > 0) {
      ocrNotes.push(tPlural('{count} scanned pages were read with OCR.', stats.ocrPagesRecognized));
    }
    if (stats.ocrPagesFailed > 0) {
      ocrNotes.push(
        tPlural('{count} scanned pages could not be read by OCR.', stats.ocrPagesFailed)
      );
    }
    if (stats.scannedPagesSkipped > 0) {
      ocrNotes.push(
        stats.ocrUnavailableReason
          ? tPlural('{count} scanned pages were skipped: {reason}', stats.scannedPagesSkipped, {
              reason: stats.ocrUnavailableReason
            })
          : statsUsedOcr
            ? tPlural('{count} scanned pages were skipped.', stats.scannedPagesSkipped)
            : tPlural(
                '{count} scanned pages have no text layer and were skipped. Turn on "Also OCR scanned pages" to search them.',
                stats.scannedPagesSkipped
              )
      );
    }
  }

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Folder Search & Index')}</h2>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => void handleSelectFolder()}
          disabled={busy}
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
            onClick={() => void handleStartIndexing()}
            disabled={busy}
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
        {busy && (
          <Button
            variant="secondary"
            size="compact"
            onClick={() => indexController.current?.abort()}
          >
            {t('Cancel')}
          </Button>
        )}
      </div>

      <Checkbox
        label={t('Also OCR scanned pages')}
        checked={ocrScans}
        disabled={busy}
        onChange={checked => void handleToggleOcr(checked)}
      />
      <p className={panelStyles.description}>
        {t(
          'Pages with no text layer are read with OCR while indexing, so scans become searchable. ' +
            'Slower; uses the OCR language chosen above. Files are not changed.'
        )}
      </p>

      {busy && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div
            role="progressbar"
            aria-label={t('Indexing progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
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

      {!busy && ocrMessage && (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo} role="status">
          {ocrMessage}
        </p>
      )}

      {stats && !busy && (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo} role="status">
          {[
            t('Indexed {files} ({pages}, {tokens}) in {ms}ms.', {
              files: tPlural('{count} PDFs', stats.filesIndexed),
              pages: tPlural('{count} pages', stats.pagesIndexed),
              tokens: tPlural('{count} tokens', stats.totalTokens),
              ms: stats.durationMs
            }),
            ...ocrNotes
          ].join(' ')}
        </p>
      )}

      <Field label={t('Search indexed PDFs')}>
        {id => (
          <TextInput
            id={id}
            value={query}
            placeholder={t('Type search terms...')}
            onInput={e => void handleSearch((e.target as HTMLInputElement).value)}
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
                style={{ padding: 0, borderRadius: 'var(--radius-sm)' }}
              >
                <button
                  type="button"
                  onClick={() => void handleJumpToPage(res)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '100%',
                    padding: '8px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'start',
                    cursor: 'pointer'
                  }}
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
                  {res.fromOcr && (
                    <span
                      title={t(
                        'This match is in text recognized by OCR, which can contain errors.'
                      )}
                      style={{
                        marginTop: '2px',
                        padding: '0 6px',
                        font: 'var(--text-micro)',
                        color: 'var(--ink-muted)',
                        border: '1px solid var(--hairline)',
                        borderRadius: 'var(--radius-pill)'
                      }}
                    >
                      {t('Recognized text')}
                    </span>
                  )}
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
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
