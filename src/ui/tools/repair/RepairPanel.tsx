/**
 * GAP-6 — Repair: choose the damaged file, then read what was fixed.
 *
 * The file is usually one the import refused ("Try to repair" on that error
 * lands here with it already chosen), so this tool works with no document
 * open. With a document open and nothing chosen, the open document's own file
 * is what gets repaired.
 */
import { FilePlus, FileText, FolderOpen } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { activeDoc, documents } from '../../../core/store';
import { registerSourceFromBytes } from '../../../core/import';
import { activeJob, notify, notifyError } from '../../../core/notify';
import { translate, useTranslation } from '../../../core/i18n';
import { Button } from '../../components/Button';
import { formatBytes } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import { MAX_OPEN_DOCUMENTS } from '../../../core/workspace-limits';
import {
  clearRepairCandidate,
  lastRepair,
  openingRepaired,
  openRepairedCopy,
  repairCandidate
} from './state';

const PDF_ONLY = { 'application/pdf': ['.pdf'] };

/** The same refusal every other open path shows at the document ceiling. */
function notifyDocumentCeiling(): void {
  notify('warning', translate('Too many documents are open.'), {
    detail: translate(
      'Stapler can keep up to {max} documents open at once (open now: {open}). Close some tabs, then open your files again.',
      { max: MAX_OPEN_DOCUMENTS, open: documents.value.length }
    )
  });
}

export function RepairPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const candidate = repairCandidate.value;
  const run = lastRepair.value;
  const opening = openingRepaired.value;

  const choose = async () => {
    if (activeJob.value !== null) {
      notify('info', translate('Finish or cancel the current operation first.'));
      return;
    }
    try {
      const [handle] = await platform.openFiles({ multiple: false, accept: PDF_ONLY });
      if (!handle) return;
      repairCandidate.value = await handle.getFile();
      lastRepair.value = null;
    } catch (err) {
      notifyError('repair.choose', err);
    }
  };

  // AUDIT-2026-10-01 RT-2 — see `openRepairedCopy`: refused at the document
  // ceiling (no false "Opened" toast, no orphaned bytes), and one copy per
  // double-click.
  const openRepaired = async () => {
    if (!run) return;
    try {
      const outcome = await openRepairedCopy(run, registerSourceFromBytes);
      if (outcome === 'full') notifyDocumentCeiling();
      else if (outcome === 'opened') {
        notify('success', translate('Opened {name}', { name: run.name }));
      }
    } catch (err) {
      notifyError('repair.open', err);
    }
  };

  const target = candidate
    ? t('File to repair: {name}', { name: candidate.name })
    : doc
      ? t('The open document, {name}, will be checked and repaired.', { name: doc.name })
      : t('Choose the damaged PDF to repair.');

  return (
    <>
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>{target}</p>
        <Button variant="secondary" icon={FolderOpen} onClick={() => void choose()}>
          {candidate || doc ? t('Choose a different file…') : t('Choose a PDF…')}
        </Button>
        {candidate && doc && (
          <Button variant="ghost" icon={FileText} onClick={clearRepairCandidate}>
            {t('Use the open document instead')}
          </Button>
        )}
      </div>

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t(
          'Repair reads everything the file still contains, rebuilds its structure, and writes a fresh copy. The copy is only offered after it opens cleanly in both of the PDF readers Stapler uses. Your original file is never changed.'
        )}
      </p>

      {run && (
        <>
          <hr className={panelStyles.divider} />
          <div className={panelStyles.section} aria-live="polite">
            <h2 className={panelStyles.title}>{t('What was found')}</h2>
            {run.result.changed ? (
              <ul className={panelStyles.proseList}>
                {run.result.findings.map(finding => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
            ) : (
              <p className={panelStyles.description}>
                {t('No damage was found — this file opens cleanly as it is.')}
              </p>
            )}
            {run.result.warnings.length > 0 && (
              <div className={panelStyles.note} role="note">
                <ul className={panelStyles.proseList}>
                  {run.result.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className={panelStyles.description}>
              {run.result.pagesBefore === null
                ? t('Pages: the original could not be opened; {after} recovered.', {
                    after: run.result.pageCount
                  })
                : t('Pages: {before} before → {after} after.', {
                    before: run.result.pagesBefore,
                    after: run.result.pageCount
                  })}
            </p>
            <p className={panelStyles.description}>
              {t('File size: {before} → {after}', {
                before: formatBytes(run.result.originalBytes),
                after: formatBytes(run.result.bytes.byteLength)
              })}
            </p>
            {run.result.changed && (
              <Button
                variant="secondary"
                icon={FilePlus}
                disabled={opening}
                aria-busy={opening}
                onClick={() => void openRepaired()}
              >
                {t('Open the repaired copy')}
              </Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
