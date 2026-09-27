import { translate } from '../../core/i18n';
/**
 * DS-05 — the home launcher: drop zone, searchable grouped tool grid, and Recents.
 *
 * This route was previously a heading and a drop zone styled with inline objects. The
 * tool grid and the Recents list DS-05 specifies did not exist at all, so the rail was
 * the only way to reach a tool and persisted file handles were never used.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { ChevronDown, Clock, Info, X } from 'lucide-preact';
import { toolRoute } from '../../core/tools';
import { searchToolGroups } from '../toolSearch';
import { importFilesAsDocuments } from '../../core/open-document';
import { notify, notifyError } from '../../core/notify';
import { platform } from '../../platform/current';
import type { RecentEntry } from '../../platform/index';
import { DropZone } from '../components/DropZone';
import { JobStatusRow } from '../components/JobStatusRow';
import { Field, TextInput } from '../components/Field';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { ToolIcon } from '../components/ToolIcon';
import styles from './HomeView.module.css';
import { useTranslation } from '../../core/i18n';
import { useImageImportOptions } from '../useImageImportOptions';

/** Recent-entry ids whose reopen is in flight. */
const reopening = new Set<string>();

export function HomeView() {
  const t = useTranslation();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const { requestOptions, node } = useImageImportOptions();
  // RT-7 — Home has no action bar, so a Recents reopen shows its own
  // progress and Cancel while it runs.
  const [reopenBusy, setReopenBusy] = useState(false);

  const toggleSection = (name: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  useEffect(() => {
    void platform.restoreHandles().then(setRecents);
  }, []);

  // `t` is a new function each render, so this recomputes whenever the
  // locale (or anything else) re-renders the view — cheap for ~40 tools.
  const groups = useMemo(() => searchToolGroups(query, t), [query, t]);

  const reopen = async (entry: RecentEntry) => {
    // A double click (or Enter pressed twice) used to open the file as two
    // tabs (AUDIT-2026-09-25 UI-27).
    if (reopening.has(entry.id)) return;
    reopening.add(entry.id);
    setReopenBusy(true);
    try {
      await reopenOnce(entry);
    } finally {
      reopening.delete(entry.id);
      setReopenBusy(reopening.size > 0);
    }
  };

  const reopenOnce = async (entry: RecentEntry) => {
    // Shared by both ways a Recents entry turns out to be unreachable: no
    // handle at all, or a handle whose permission is still 'granted' from a
    // prior session but whose underlying file was moved or deleted since —
    // FSA permission state does not verify the file still exists, so that
    // second case only surfaces once `getFile()` actually tries to read it.
    // Both deserve the same message; only the generic catch-all below used to
    // answer for the second one.
    const reportUnreachable = () => {
      notify('warning', translate('Could not reopen {name}.', { name: entry.name }), {
        detail: 'Permission was declined, or the file has moved. Open it again from disk.'
      });
    };

    try {
      // Chrome drops file permission between sessions, so this re-prompts.
      const handle = await platform.reopenHandle(entry.id);
      if (!handle) {
        reportUnreachable();
        return;
      }
      let file: File;
      try {
        file = await handle.getFile();
      } catch {
        reportUnreachable();
        return;
      }
      // The same open path as the drop zone (RT-6/RT-7): one undo step,
      // cancellable through the job Cancel, and RT-14's restore-prompt gate —
      // which `importFilesAsDocuments` checks after `reopenHandle`, whose
      // permission prompt needs the click's user activation.
      const result = await importFilesAsDocuments([file], {
        handles: [handle],
        requestImageOptions: requestOptions
      });
      if (result.imported > 0) setLocation(toolRoute('organize'));
    } catch (err) {
      notifyError('recents.reopen', err);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div>
          <h1 className={styles.title}>{t('Offline PDF tools')}</h1>
          <p className={styles.subtitle}>
            {t('Everything runs on this device. No upload, no account, no limits.')}
          </p>
        </div>

        <DropZone onImported={() => setLocation(toolRoute('organize'))} />
        {reopenBusy && <JobStatusRow />}
        {node}

        <div className={styles.section}>
          <Field label={t('Search tools')}>
            {id => (
              <TextInput
                id={id}
                value={query}
                placeholder={t('merge, compress, redact…')}
                onInput={event => setQuery((event.target as HTMLInputElement).value)}
              />
            )}
          </Field>

          {groups.length === 0 && (
            <p className={styles.empty}>{t('No tool matches “{query}”.', { query })}</p>
          )}

          {groups.map(({ group, label, tools }) => {
            const isCollapsed = collapsedSections.has(group);
            const sectionId = `home-section-${group}`;
            return (
              <div className={styles.section} key={group}>
                <button
                  type="button"
                  className={`${styles.sectionTitle} ${styles.sectionToggle}`}
                  onClick={() => toggleSection(group)}
                  aria-expanded={!isCollapsed}
                  aria-controls={sectionId}
                >
                  <span>{label}</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={`${styles.sectionChevron} ${isCollapsed ? styles.sectionChevronCollapsed : ''}`}
                  />
                </button>
                <ul className={styles.toolGrid} id={sectionId} hidden={isCollapsed}>
                  {tools.map(tool => (
                    <li key={tool.id}>
                      <a className={styles.tool} href={`#${toolRoute(tool.id)}`}>
                        <ToolIcon name={tool.icon} size={18} />
                        <span className={styles.toolBody}>
                          <span>{t(tool.title)}</span>
                          <span className={styles.toolSummary}>{t(tool.summary)}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {recents.length > 0 ? (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>{t('Recent')}</h2>
            <ul className={styles.recents}>
              {recents.slice(0, 8).map(entry => (
                <li className={styles.recentRow} key={entry.id}>
                  <Button
                    variant="tertiary"
                    size="compact"
                    icon={Clock}
                    onClick={() => void reopen(entry)}
                  >
                    {entry.name}
                  </Button>
                  <IconButton
                    icon={X}
                    size="compact"
                    aria-label={translate('Forget {name}', { name: entry.name })}
                    onClick={async () => {
                      try {
                        await platform.revokeHandle(entry.id);
                        setRecents(await platform.restoreHandles());
                      } catch (err) {
                        notifyError('recents.forget', err);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          platform.supportsFileSystemAccess && (
            <p className={styles.empty}>
              <Info size={14} aria-hidden="true" />
              {t(
                'Files you open appear here so you can reopen them in one click. Only a reference is stored, never the document.'
              )}
            </p>
          )
        )}
      </div>
    </div>
  );
}
