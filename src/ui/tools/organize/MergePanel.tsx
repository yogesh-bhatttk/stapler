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
import { importFiles } from '../../../core/import';
import { appendPages, activeDoc, activeSources } from '../../../core/store';
import { notify, notifyError } from '../../../core/notify';
import { Button } from '../../components/Button';
import { useImageImportOptions } from '../../useImageImportOptions';
import { isPdfFile } from '../../../core/import';
import { isSupportedImage } from '../../../core/image';
import { panelStyles } from '../../shell/OptionsPanel';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

export function MergePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const sourceList = activeSources.value;
  const { run } = useJob();
  const [busy, setBusy] = useState(false);
  const { requestOptions, node } = useImageImportOptions();

  const addFiles = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const opened = await platform.openFiles({ multiple: true, accept: PDF_AND_IMAGES });
      if (opened.length === 0) return;
      const files = await Promise.all(opened.map(handle => handle.getFile()));
      let imageOptions = undefined;
      if (files.some(f => !isPdfFile(f) && isSupportedImage(f))) {
        const opts = await requestOptions(files);
        if (!opts) {
          setBusy(false);
          return;
        }
        imageOptions = opts;
      }

      await run({ label: 'Importing', scope: 'merge.add' }, async job => {
        const outcome = await importFiles(files, job, imageOptions);
        for (const imported of outcome.imported) {
          appendPages(doc.id, imported.pages);
          for (const warning of imported.warnings) {
            notify('warning', imported.source.name, { detail: warning });
          }
        }
        // A failure on one file never stops the others, and each says why.
        for (const failure of outcome.failures) {
          notify('danger', `Could not add ${failure.name}`, { detail: failure.message });
        }
        if (outcome.imported.length > 0) {
          notify('success', `Added ${outcome.imported.length} document(s).`);
        }
      });
    } catch (err) {
      notifyError('merge.add', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" icon={Plus} onClick={addFiles} disabled={busy || !doc}>
        {t('Add PDFs or images')}
      </Button>
      {node}

      {sourceList.length > 0 && (
        <div className={panelStyles.section}>
          <h3 className={panelStyles.title}>{t('Source files')}</h3>
          <ol className={panelStyles.list}>
            {sourceList.map((source, index) => (
              <li className={panelStyles.listRow} key={source.id} title={source.name}>
                <span className={panelStyles.listRowText}>
                  {index + 1}. {source.name}
                </span>
                <span>{source.pageCount}p</span>
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
    </>
  );
}
