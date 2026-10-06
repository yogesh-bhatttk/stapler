/**
 * GAP-9 / GAP-12 — "Stored on this device", inside the trust panel.
 *
 * "Nothing is uploaded" is only half the privacy story; this lists what *is*
 * kept in this browser, how much space it takes, whether the browser has
 * promised not to evict it, and offers to delete it — per category where that
 * is cheap, or everything at once.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Trash2 } from 'lucide-preact';
import { Button } from './Button';
import styles from './InfoModals.module.css';
import { tPlural, useTranslation } from '../../core/i18n';
import { gatherLocalDataReport, type LocalDataReport } from '../../core/local-data';
import {
  formatStorageBytes,
  requestPersistenceNow,
  type PersistOutcome
} from '../../core/storage-persistence';
import { documents } from '../../core/store';
import {
  confirmAndClearAllLocalData,
  confirmAndClearCategory,
  type ClearCategory
} from '../clearLocalData';
import { withErrorToast } from '../asyncHandler';

interface Row {
  id: string;
  label: string;
  value: string;
  clear?: ClearCategory;
  clearLabel?: string;
}

export function LocalDataSection() {
  const t = useTranslation();
  const [report, setReport] = useState<LocalDataReport | null>(null);
  const [asked, setAsked] = useState<PersistOutcome | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    let live = true;
    // AUDIT-2026-10-01 X-11 — `gatherLocalDataReport` is written never to
    // throw, but a rejection here used to leave "Checking browser storage…"
    // on screen forever as an unhandled rejection.
    gatherLocalDataReport().then(
      next => {
        if (!live) return;
        setFailed(false);
        setReport(next);
      },
      () => {
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const openDocs = documents.value.length;

  const clear = async (category: ClearCategory) => {
    setWorking(true);
    try {
      if (await confirmAndClearCategory(category)) refresh();
    } finally {
      setWorking(false);
    }
  };

  const clearAll = async () => {
    setWorking(true);
    try {
      await confirmAndClearAllLocalData();
    } finally {
      setWorking(false);
    }
  };

  const askPersistence = async () => {
    setWorking(true);
    try {
      setAsked(await requestPersistenceNow());
      refresh();
    } finally {
      setWorking(false);
    }
  };

  if (!report) {
    return (
      <section className={styles.grid} aria-labelledby="stored-data-title">
        <h3 id="stored-data-title" className={styles.groupTitle}>
          {t('Stored on this device')}
        </h3>
        {failed ? (
          <>
            <p className={styles.pointBody} role="alert">
              {t('Browser storage could not be read.')}
            </p>
            <div>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  setFailed(false);
                  refresh();
                }}
              >
                {t('Try again')}
              </Button>
            </div>
          </>
        ) : (
          <p className={styles.pointBody} role="status">
            {t('Checking browser storage…')}
          </p>
        )}
      </section>
    );
  }

  const db = report.db;
  const rows: Row[] = [
    {
      id: 'documents',
      label: t('Open and recoverable documents'),
      value:
        report.documents.files === 0
          ? t('None')
          : `${tPlural('{count} files', report.documents.files)} · ${formatStorageBytes(report.documents.bytes)}`
    },
    {
      id: 'ocr',
      label: t('OCR language models'),
      value:
        report.ocrModels.langs.length === 0
          ? t('None')
          : `${report.ocrModels.langs.join(', ')} · ${formatStorageBytes(report.ocrModels.bytes)}`,
      clear: report.ocrModels.langs.length > 0 ? 'ocrModels' : undefined,
      clearLabel: t('Remove stored OCR language models')
    }
  ];
  if (db) {
    rows.push(
      {
        id: 'signatures',
        label: t('Saved signatures and initials'),
        value:
          db.signatures.count === 0
            ? t('None')
            : `${tPlural('{count} saved', db.signatures.count)} · ${formatStorageBytes(db.signatures.bytes)}`,
        clear: db.signatures.count > 0 ? 'signatures' : undefined,
        clearLabel: t('Delete saved signatures')
      },
      {
        id: 'recents',
        label: t('Recent files (how to reopen them, not copies)'),
        value: db.recents === 0 ? t('None') : tPlural('{count} files', db.recents),
        clear: db.recents > 0 ? 'recents' : undefined,
        clearLabel: t('Clear recent files')
      },
      {
        id: 'index',
        label: t('Folder-search index'),
        value: db.indexedFiles === 0 ? t('None') : tPlural('{count} files', db.indexedFiles),
        clear: db.indexedFiles > 0 ? 'searchIndex' : undefined,
        clearLabel: t('Clear the folder-search index')
      },
      {
        id: 'presets',
        label: t('Presets and saved recipes'),
        value: db.presets + db.recipes === 0 ? t('None') : String(db.presets + db.recipes)
      },
      {
        id: 'settings',
        label: t('Settings, shortcuts and session record'),
        value:
          db.settings + report.localStorageKeys === 0
            ? t('None')
            : tPlural('{count} entries', db.settings + report.localStorageKeys)
      }
    );
  }

  const persisted = report.persisted;
  const persistenceText =
    persisted === true
      ? t('Persistent: the browser will not clear this data on its own.')
      : persisted === false
        ? t('Not persistent: the browser may clear this data when space runs low.')
        : t('This browser does not say whether this data is kept.');

  return (
    <section className={styles.grid} aria-labelledby="stored-data-title">
      <h3 id="stored-data-title" className={styles.groupTitle}>
        {t('Stored on this device')}
      </h3>
      <p className={styles.pointBody}>
        {report.estimate
          ? t('{used} of {quota} available to this site is in use.', {
              used: formatStorageBytes(report.estimate.usage),
              quota: formatStorageBytes(report.estimate.quota)
            })
          : t('This browser does not report how much storage is in use.')}{' '}
        {persistenceText}
      </p>
      {persisted === false && (
        <div>
          <Button
            variant="secondary"
            size="compact"
            disabled={working}
            onClick={withErrorToast('local-data.persist', askPersistence)}
          >
            {t('Ask the browser to keep this data')}
          </Button>
          {asked === 'denied' && (
            <p className={styles.pointBody} role="status">
              {t('The browser declined. Export documents you need to keep.')}
            </p>
          )}
        </div>
      )}
      {!db && (
        <p className={styles.pointBody} role="status">
          {t('Browser storage could not be read, so this list may be incomplete.')}
        </p>
      )}

      <ul className={styles.rows} aria-label={t('Stored on this device')}>
        {rows.map(row => (
          <li key={row.id} className={`${styles.row} ${styles.storageRow}`}>
            <span className={styles.storageLabel}>{row.label}</span>
            <span className={styles.storageValue}>
              {row.value}
              {row.clear && row.clearLabel && (
                <Button
                  variant="ghost"
                  size="compact"
                  icon={Trash2}
                  disabled={working}
                  aria-label={row.clearLabel}
                  title={row.clearLabel}
                  onClick={() => void clear(row.clear as ClearCategory)}
                />
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className={`${styles.callout} ${styles.dangerZone}`}>
        <p className={styles.pointBody}>
          {openDocs > 0
            ? tPlural('Clearing everything also closes the {count} open documents.', openDocs)
            : t('Clearing everything deletes all of the above and reloads Stapler.')}
        </p>
        <Button variant="danger" size="compact" disabled={working} onClick={() => void clearAll()}>
          {t('Clear all local data…')}
        </Button>
      </div>
    </section>
  );
}
