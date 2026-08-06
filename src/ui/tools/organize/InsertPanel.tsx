/**
 * OPS-04 — insert pages from another document at a chosen position.
 *
 * Distinct from `MergePanel`: merge combines whole documents, this drops a new
 * document's pages into a specific gap in the one already open. It previously
 * reused `MergePanel`, whose "add files" always appended to the end — there was
 * no way to choose where the pages landed short of appending, then dragging
 * them into place in the grid by hand.
 */
import { useState } from 'preact/hooks';
import { FilePlus } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { PDF_AND_IMAGES } from '../../../platform/index';
import { importFiles } from '../../../core/import';
import { activeDoc, insertPages, selectedPageKeys, setPageSelection } from '../../../core/store';
import { notify, notifyError } from '../../../core/notify';
import { Button } from '../../components/Button';
import { useImageImportOptions } from '../../useImageImportOptions';
import { isPdfFile } from '../../../core/import';
import { isSupportedImage } from '../../../core/image';
import { Field, NumberStepper } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

/** Right after the last selected page, or the end of the document if none. */
function defaultInsertIndex(doc: { pages: { key: string }[] }, selected: Set<string>): number {
  if (selected.size === 0) return doc.pages.length;
  const indices = doc.pages
    .map((page, index) => (selected.has(page.key) ? index : -1))
    .filter(index => index >= 0);
  return Math.max(...indices) + 1;
}

export function InsertPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const [busy, setBusy] = useState(false);
  const { requestOptions } = useImageImportOptions();
  // `null` follows the current grid selection; a number is an explicit override
  // once the user has touched the stepper. Cleared after each insert so the next
  // one goes back to following whatever is selected.
  const [manualIndex, setManualIndex] = useState<number | null>(null);

  if (!doc) return null;
  const pageCount = doc.pages.length;
  const liveDefault = defaultInsertIndex(doc, selectedPageKeys.value);
  const clampedIndex = Math.min(manualIndex ?? liveDefault, pageCount);

  const addFiles = async () => {
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

      await run({ label: 'Importing', scope: 'insert.add' }, async job => {
        const outcome = await importFiles(files, job, imageOptions);
        let at = clampedIndex;
        const insertedKeys: string[] = [];
        for (const imported of outcome.imported) {
          insertPages(doc.id, imported.pages, at);
          insertedKeys.push(...imported.pages.map(p => p.key));
          at += imported.pages.length;
          for (const warning of imported.warnings) {
            notify('warning', imported.source.name, { detail: warning });
          }
        }
        // A failure on one file never stops the others, and each says why.
        for (const failure of outcome.failures) {
          notify('danger', `Could not add ${failure.name}`, { detail: failure.message });
        }
        if (insertedKeys.length > 0) {
          // Selecting the newly-inserted pages is the "visible insertion
          // indicator" for a non-drag insert: the grid highlights exactly
          // where the pages landed, the same way a drag's drop line does.
          setPageSelection(insertedKeys);
          setManualIndex(null);
          notify(
            'success',
            `Inserted ${insertedKeys.length} page(s) at position ${clampedIndex + 1}.`
          );
        }
      });
    } catch (err) {
      notifyError('insert.add', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label={t('Insert at position')}
        hint={clampedIndex === 0 ? 'At the start' : `After page ${clampedIndex}`}
      >
        {id => (
          <NumberStepper
            id={id}
            value={clampedIndex}
            min={0}
            max={pageCount}
            onChange={setManualIndex}
            ariaLabel="Insert at position"
          />
        )}
      </Field>

      <Button variant="secondary" icon={FilePlus} onClick={addFiles} disabled={busy}>
        {t('Choose PDFs or images to insert')}
      </Button>

      {pageCount === 0 && (
        <p className={panelStyles.description}>{t('This document has no pages yet.')}</p>
      )}
    </>
  );
}
