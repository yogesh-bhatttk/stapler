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
import { Clock, Info, X } from 'lucide-preact';
import { TOOLS, groupedTools, toolRoute } from '../../core/tools';
import { importFiles } from '../../core/import';
import { addDocument, makePageRefs } from '../../core/store';
import { notify, notifyError } from '../../core/notify';
import { platform } from '../../platform/current';
import type { RecentEntry } from '../../platform/index';
import { DropZone } from '../components/DropZone';
import { Field, TextInput } from '../components/Field';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { ToolIcon } from '../components/ToolIcon';
import { fuzzyRank } from '../../core/fuzzy';
import styles from './HomeView.module.css';
import { useTranslation } from '../../core/i18n';
import { useImageImportOptions } from '../useImageImportOptions';
import { isPdfFile } from '../../core/import';
import { isSupportedImage } from '../../core/image';

export function HomeView() {
  const t = useTranslation();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const { requestOptions, node } = useImageImportOptions();

  useEffect(() => {
    void platform.restoreHandles().then(setRecents);
  }, []);

  const groups = useMemo(() => {
    if (!query.trim()) return groupedTools();
    // While searching, a single ranked list beats four sparse groups.
    const matches = fuzzyRank(TOOLS, query, tool => `${tool.title} ${tool.group} ${tool.summary}`);
    return matches.length > 0 ? [{ group: 'Matches', tools: matches }] : [];
  }, [query]);

  const reopen = async (entry: RecentEntry) => {
    try {
      // Chrome drops file permission between sessions, so this re-prompts.
      const handle = await platform.reopenHandle(entry.id);
      if (!handle) {
        notify('warning', translate('Could not reopen {name}.', { name: entry.name }), {
          detail: 'Permission was declined, or the file has moved. Open it again from disk.'
        });
        return;
      }
      const files = [await handle.getFile()];
      let imageOptions = undefined;
      if (files.some(f => !isPdfFile(f) && isSupportedImage(f))) {
        const opts = await requestOptions(files);
        if (!opts) return;
        imageOptions = opts;
      }
      const outcome = await importFiles(files, {}, imageOptions);
      for (const imported of outcome.imported) {
        addDocument({
          id: crypto.randomUUID(),
          name: imported.source.name,
          pages: makePageRefs(imported.source.id, imported.source.pageCount),
          annotations: [],
          dirty: false,
          sourceHandle: handle.writable ? { fileId: handle.id, writable: true } : undefined
        });
      }
      for (const failure of outcome.failures) {
        notify('danger', translate('Could not open {name}', { name: failure.name }), {
          detail: failure.message
        });
      }
      if (outcome.imported.length > 0) setLocation(toolRoute('organize'));
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
            <p className={styles.empty}>
              {t('No tool matches “')}
              {query}”.
            </p>
          )}

          {groups.map(({ group, tools }) => (
            <div className={styles.section} key={group}>
              <h2 className={styles.sectionTitle}>{group}</h2>
              <ul className={styles.toolGrid}>
                {tools.map(tool => (
                  <li key={tool.id}>
                    <a className={styles.tool} href={`#${toolRoute(tool.id)}`}>
                      <ToolIcon name={tool.icon} size={18} />
                      <span className={styles.toolBody}>
                        <span>{tool.title}</span>
                        <span className={styles.toolSummary}>{tool.summary}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
                    aria-label={`Forget ${entry.name}`}
                    onClick={async () => {
                      await platform.revokeHandle(entry.id);
                      setRecents(await platform.restoreHandles());
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
