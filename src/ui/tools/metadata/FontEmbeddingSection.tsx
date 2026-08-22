/**
 * DOC-12 — the font-embedding checker and one-click fix.
 *
 * Embedding a font changes every page's `/Resources/Font` but not a single
 * page's content, size, or annotations, so this repoints every page at the
 * fixed bytes with `repointPage` (one call per page, collapsed into a single
 * undo entry) rather than `replaceWithSource`, which clears annotations —
 * appropriate for a scan-cleanup pixel rewrite, wrong here, since nothing a
 * user has stamped on the page needs to be re-created for a font fix.
 */
import { useState } from 'preact/hooks';
import { ScanSearch } from 'lucide-preact';
import { activeDoc, registerSource, repointPage, type SourceDocument } from '../../../core/store';
import { beginTransaction } from '../../../core/history';
import {
  checkFontEmbedding,
  currentDocumentBytes,
  embedMissingFont
} from '../../../core/operations';
import { renderWorker } from '../../../core/workers';
import type { FontEmbeddingFinding } from '../../../core/workers/process.worker';
import { writeSourceBytes } from '../../../core/opfs';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

export function FontEmbeddingSection() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const [findings, setFindings] = useState<FontEmbeddingFinding[] | null>(null);
  // Own reactive busy flag rather than `useJob`'s `isRunning()`: that reads a
  // plain ref, not a signal, so a component that also calls a local state
  // setter from inside the job callback (as this one does, via `setFindings`)
  // can end up rendering once while the ref is still "running" and never
  // render again to pick up the moment it clears — the disabled button would
  // then never re-enable. Local `useState` guarantees the render that clears
  // it actually happens.
  const [busy, setBusy] = useState(false);
  const { run } = useJob();
  if (!doc) return null;

  const check = async () => {
    setBusy(true);
    try {
      await run({ label: 'Checking font embedding', scope: 'fonts.check' }, async job => {
        const bytes = await currentDocumentBytes(job);
        const report = await checkFontEmbedding(bytes);
        setFindings(report.findings);
      });
    } finally {
      setBusy(false);
    }
  };

  const embed = async (baseFont: string) => {
    setBusy(true);
    try {
      await run({ label: `Embedding ${baseFont}`, scope: 'fonts.embed' }, async job => {
        const bytes = await currentDocumentBytes(job);
        const fixed = await embedMissingFont(bytes, baseFont);

        const info = await renderWorker.lease(api => api.loadDocument(fixed));
        try {
          const newSource: SourceDocument = {
            id: crypto.randomUUID(),
            name: doc.name,
            pageCount: info.pageCount,
            pageSizes: info.pageSizes
          };
          await writeSourceBytes(newSource.id, fixed);
          registerSource(newSource);

          const tx = beginTransaction('embed-font');
          doc.pages.forEach((page, index) => {
            repointPage(doc.id, page.key, newSource.id, index);
          });
          tx.end();
        } finally {
          await renderWorker.lease(api => api.closeDocument(info.handle));
        }

        notify('success', t('Embedded "{font}".', { font: baseFont }));
        setFindings(prev => prev?.filter(finding => finding.baseFont !== baseFont) ?? null);
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Font embedding')}</h2>
      <p className={panelStyles.description}>
        {t(
          'A font referenced by name but not embedded can look different in a viewer that lacks it.'
        )}
      </p>
      <Button variant="secondary" icon={ScanSearch} onClick={check} disabled={busy}>
        {t('Check font embedding')}
      </Button>

      {findings && findings.length === 0 && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('Every font in this document is embedded.')}
        </p>
      )}

      {findings && findings.length > 0 && (
        <ul className={panelStyles.list}>
          {findings.map(finding => (
            <li className={panelStyles.listRow} key={finding.baseFont}>
              <span className={panelStyles.listRowText}>
                {finding.baseFont} —{' '}
                {t('page(s) {pages}', {
                  pages: finding.pages.map(p => p + 1).join(', ')
                })}
              </span>
              {finding.standardFontMatch ? (
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => embed(finding.baseFont)}
                >
                  {t('Embed')}
                </Button>
              ) : (
                <span title={t('No safe local substitute is available.')}>{t('No match')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
