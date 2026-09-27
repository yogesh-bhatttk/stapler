/**
 * The action bar: status on the left, the single primary CTA on the right
 * (DESIGN-ADAPTATION §4.2).
 *
 * It used to hold the entire commit pipeline for every tool in one 100-line
 * `if`-chain, report through `alert()`, and render a Cancel button with no handler at
 * all. Commit logic now lives in `tools/commit.ts`; Cancel actually aborts.
 */

import { useActiveTool } from '../useActiveTool';
import { activeDoc, selectedPageKeys } from '../../core/store';
import { activeJob } from '../../core/notify';

import { Button } from '../components/Button';
import { ProgressBar } from '../components/Feedback';
import { commitTool, TOOLS_WITH_EXPORT_REVIEW } from '../tools/commit';
import { commitGate } from '../tools/commit-gate';
import { confirmAndDiscardAllChanges, hasAnythingToDiscard } from '../discardAllChanges';
import { useJob } from '../useJob';
import styles from './ActionBar.module.css';
import { tPlural, useTranslation } from '../../core/i18n';

export function ActionBar() {
  const t = useTranslation();
  const tool = useActiveTool();
  const doc = activeDoc.value;
  const job = activeJob.value;
  const { run } = useJob();

  if (!tool) return null;

  const selected = selectedPageKeys.value.size;
  const busy = job !== null;
  /**
   * PLAN §5.5 — a tool whose output must be previewed before it is saved (CNV-08)
   * blocks its own CTA from here. The reason is rendered next to the status text
   * as well as put on the button, because a disabled control with no explanation
   * is not an accessible one; the panel states it at length too.
   */
  // Gate reasons are stored as English keys (tKey) and translated here.
  const rawGate = commitGate(tool.id);
  const gate = rawGate === null ? null : t(rawGate);
  // A tool whose commit routes through a review step first. The compose-only
  // tools say so on the button itself ("View changes…" — see `core/tools.ts`);
  // the rest still do real work first (Compress, OCR, Sign…) and keep a
  // verb-led label, so this line is what tells *those* the click won't just
  // save immediately either.
  const previewsFirst = !gate && TOOLS_WITH_EXPORT_REVIEW.has(tool.id);

  return (
    <div className={styles.actionBar}>
      <span className={styles.status}>
        {doc ? tPlural('{count} pages', doc.pages.length) : t('No document')}
        {selected > 0 && ` · ${t('{count} selected', { count: selected })}`}
      </span>

      {job ? (
        <div className={styles.progress}>
          <ProgressBar label={job.label} value={job.progress} />
        </div>
      ) : gate ? (
        <span className={styles.gate} id={`commit-gate-${tool.id}`}>
          {gate}
        </span>
      ) : previewsFirst ? (
        <span className={styles.gate}>
          {t('Shows a preview first — nothing is saved until you confirm it.')}
        </span>
      ) : (
        <span className={styles.spacer} />
      )}

      <div className={styles.actions}>
        {/* Document-level, not tool-specific — a rotation done in Organize, a
            crop box, and a watermark are all "changes to this document"
            regardless of which panel happens to be open, so this lives on
            the action bar (present on every tool) rather than duplicated
            into each panel that can make a change. */}
        {doc && !busy && hasAnythingToDiscard(doc) && (
          <Button variant="tertiary" onClick={() => void confirmAndDiscardAllChanges(doc)}>
            {t('Discard all changes…')}
          </Button>
        )}
        {/* Only shown while there is something to cancel, rather than being a
            permanently dead control. */}
        {job && (
          <Button variant="tertiary" onClick={job.cancel}>
            {t('Cancel')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={(!doc && !tool.worksWithoutDocument) || busy || gate !== null}
          title={gate ?? undefined}
          aria-describedby={gate ? `commit-gate-${tool.id}` : undefined}
          onClick={() =>
            run({ label: t(tool.commitLabel), scope: `commit.${tool.id}` }, jobOptions =>
              commitTool(tool.id, jobOptions)
            )
          }
        >
          {busy ? t('Working…') : t(tool.commitLabel)}
        </Button>
      </div>
    </div>
  );
}
