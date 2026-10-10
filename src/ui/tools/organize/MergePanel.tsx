import { translate, useTranslation } from '../../../core/i18n';
/**
 * Merge / insert options (OPS-01, OPS-04).
 *
 * The "add files" flow lives here and calls the single import pipeline, rather than
 * being a third copy of it as it was before.
 */
import { useState } from 'preact/hooks';
import { Plus } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { PDF_AND_IMAGES } from '../../../platform/index';
import { activeDoc, activeSources } from '../../../core/store';
import { notifyError } from '../../../core/notify';
import { Button } from '../../components/Button';
import { useImageImportOptions } from '../../useImageImportOptions';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import {
  importIntoDocument,
  mayPickFilesToAdd,
  notifyMerged,
  prepareFilesToAdd
} from './import-into-document';
import { DuplexSection } from './DuplexSection';

export function MergePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const sourceList = activeSources.value;
  const { run } = useJob();
  const [busy, setBusy] = useState(false);
  const { requestOptions, node } = useImageImportOptions();

  const addFiles = async () => {
    // Checked before the picker opens, not after: otherwise the user chooses
    // files only for the import to be refused and the choice discarded (UI-20).
    // M7 — and refused under the restore prompt, like every open path.
    setBusy(true);
    try {
      if (!(await mayPickFilesToAdd())) return;
      const opened = await platform.openFiles({ multiple: true, accept: PDF_AND_IMAGES });
      if (opened.length === 0) return;
      const files = await Promise.all(opened.map(handle => handle.getFile()));
      // M7 — the document ceiling and memory soft limit. With nothing open,
      // the first file becomes a new document — merge builds a document from
      // scratch just like images-to-pdf does.
      const prepared = await prepareFilesToAdd(files, doc ? 0 : 1, requestOptions);
      if (!prepared) return;

      await run({ label: translate('Importing'), scope: 'merge.add' }, async job => {
        const added = await importIntoDocument(files, job, prepared.imageOptions, {
          docId: doc?.id ?? null,
          createIfMissing: true
        });
        if (added) notifyMerged(added.files);
      });
    } catch (err) {
      notifyError('merge.add', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" icon={Plus} onClick={() => void addFiles()} disabled={busy}>
        {t('Add PDFs or images')}
      </Button>
      {node}

      {sourceList.length > 0 && (
        <div className={panelStyles.section}>
          <h2 className={panelStyles.title}>{t('Source files')}</h2>
          <ol className={panelStyles.list}>
            {sourceList.map((source, index) => (
              <li className={panelStyles.listRow} key={source.id} title={source.name}>
                <span className={panelStyles.listRowText}>
                  {index + 1}. {source.name}
                </span>
                <span>{t('{count}p', { count: source.pageCount })}</span>
              </li>
            ))}
          </ol>
          <p className={panelStyles.description}>
            {t(
              'Drag pages in the grid to reorder across files. Page sizes are preserved as they are.'
            )}
          </p>
          <p className={panelStyles.description}>
            {t(
              'Bookmarks that point directly at a page carry over into the merged document. Bookmarks using a named destination or a non-standard action are left out.'
            )}
          </p>
        </div>
      )}
      {doc && doc.pages.length > 1 && (
        <>
          <hr className={panelStyles.divider} />
          <DuplexSection />
        </>
      )}
    </>
  );
}
