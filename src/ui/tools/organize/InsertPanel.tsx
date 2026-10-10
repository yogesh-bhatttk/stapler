import { translate, useTranslation } from '../../../core/i18n';
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
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { notifyError } from '../../../core/notify';
import { Button } from '../../components/Button';
import { useImageImportOptions } from '../../useImageImportOptions';
import {
  importIntoDocument,
  mayPickFilesToAdd,
  notifyInserted,
  prepareFilesToAdd
} from './import-into-document';
import { Field, NumberStepper } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';

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
  // M7 / UI#5 — `node` is the image options dialog; without rendering it,
  // `requestOptions` waited for an answer no one could give.
  const { requestOptions, node } = useImageImportOptions();
  // `null` follows the current grid selection; a number is an explicit override
  // once the user has touched the stepper. Cleared after each insert so the next
  // one goes back to following whatever is selected.
  const [manualIndex, setManualIndex] = useState<number | null>(null);

  if (!doc) return null;
  const pageCount = doc.pages.length;
  const liveDefault = defaultInsertIndex(doc, selectedPageKeys.value);
  const clampedIndex = Math.min(manualIndex ?? liveDefault, pageCount);

  const addFiles = async () => {
    // M7 — the same pre-checks as Merge: no picker while a job runs or the
    // restore prompt is up (UI-20, RT-14).
    setBusy(true);
    try {
      if (!(await mayPickFilesToAdd())) return;
      const opened = await platform.openFiles({ multiple: true, accept: PDF_AND_IMAGES });
      if (opened.length === 0) return;
      const files = await Promise.all(opened.map(handle => handle.getFile()));
      // M7 — pages go into this document: no new document, but the memory
      // soft limit still applies.
      const prepared = await prepareFilesToAdd(files, 0, requestOptions);
      if (!prepared) return;

      const position = clampedIndex;
      await run({ label: translate('Importing'), scope: 'insert.add' }, async job => {
        const added = await importIntoDocument(files, job, prepared.imageOptions, {
          docId: doc.id,
          at: position,
          createIfMissing: false
        });
        if (added && added.keys.length > 0) {
          setManualIndex(null);
          notifyInserted(added.keys, position);
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
        hint={clampedIndex === 0 ? t('At the start') : t('After page {n}', { n: clampedIndex })}
      >
        {id => (
          <NumberStepper
            id={id}
            value={clampedIndex}
            min={0}
            max={pageCount}
            onChange={setManualIndex}
            ariaLabel={t('Insert at position')}
          />
        )}
      </Field>

      <Button variant="secondary" icon={FilePlus} onClick={() => void addFiles()} disabled={busy}>
        {t('Choose PDFs or images to insert')}
      </Button>
      {node}

      {pageCount === 0 && (
        <p className={panelStyles.description}>{t('This document has no pages yet.')}</p>
      )}
    </>
  );
}
