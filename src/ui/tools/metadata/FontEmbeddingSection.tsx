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
import { activeDoc, documents, repointPage } from '../../../core/store';
import { cancelled } from '../../../core/errors';
import { documentContentBytes } from '../export-compose';
import { registerSourceFromBytes } from '../../../core/import';
import { beginTransaction } from '../../../core/history';
import { checkFontEmbedding, embedMissingFont } from '../../../core/operations';
import type { FontEmbeddingFinding } from '../../../core/workers/process.worker';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { translate, useTranslation } from '../../../core/i18n';

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
      await run(
        { label: translate('Checking font embedding'), scope: 'fonts.check' },
        async job => {
          // M2 — the pages' own fonts: the exported bytes added the
          // watermark's and header/footer's standard fonts, which are never
          // embedded, so every watermarked document "needed" a font fix.
          const bytes = await documentContentBytes(job, { stamps: false });
          const report = await checkFontEmbedding(bytes);
          if (job.signal?.aborted) return;
          setFindings(report.findings);
        }
      );
    } finally {
      setBusy(false);
    }
  };

  const embed = async (baseFont: string) => {
    setBusy(true);
    try {
      await run(
        { label: translate('Embedding {font}', { font: baseFont }), scope: 'fonts.embed' },
        async job => {
          // AUDIT-2026-10-10 M2 — the page content alone. `repointPage`
          // keeps each page's key, rotation-free, and its stamps, so the
          // exported bytes used here before (crop box, stamps, watermark,
          // header/footer baked in) had all of those applied a second time
          // at the next export: a crop cropped twice, every stamp and
          // watermark drawn twice. The pages composed are the ones read in
          // this same tick, so index `i` of the result is `pages[i]`.
          const pages = doc.pages;
          const bytes = await documentContentBytes(job, { stamps: false, pages });
          const fixed = await embedMissingFont(bytes, baseFont);

          // RT-22 — parsed, stored and registered with the load and the close
          // on one pinned render-worker instance (see `registerSourceFromBytes`).
          const newSource = await registerSourceFromBytes(fixed, doc.name);
          // M1 — cancelled (leaving the panel aborts the job, cooperatively):
          // the document is not touched.
          if (job.signal?.aborted) throw cancelled();
          // Repointed by key, so a page moved meanwhile still gets its own
          // rebuilt page; a page deleted meanwhile is simply not there.
          const live = documents.value.find(d => d.id === doc.id);
          if (!live) return;
          const tx = beginTransaction('embed-font', undefined, doc.id);
          pages.forEach((page, index) => {
            if (live.pages.some(p => p.key === page.key)) {
              repointPage(doc.id, page.key, newSource.id, index);
            }
          });
          tx.end();

          notify('success', t('Embedded "{font}".', { font: baseFont }));
          setFindings(prev => prev?.filter(finding => finding.baseFont !== baseFont) ?? null);
        }
      );
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
      <Button variant="secondary" icon={ScanSearch} onClick={() => void check()} disabled={busy}>
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
                  onClick={() => void embed(finding.baseFont)}
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
