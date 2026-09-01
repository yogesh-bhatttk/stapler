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
import { commitTool } from '../tools/commit';
import { commitGate } from '../tools/commit-gate';
import { useJob } from '../useJob';
import styles from './ActionBar.module.css';
import { useTranslation } from '../../core/i18n';

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
  const gate = commitGate(tool.id);

  return (
    <div className={styles.actionBar}>
      <span className={styles.status}>
        {doc ? `${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}` : 'No document'}
        {selected > 0 && ` · ${selected} selected`}
      </span>

      {job ? (
        <div className={styles.progress}>
          <ProgressBar label={job.label} value={job.progress} />
        </div>
      ) : gate ? (
        <span className={styles.gate} id={`commit-gate-${tool.id}`}>
          {gate}
        </span>
      ) : (
        <span className={styles.spacer} />
      )}

      <div className={styles.actions}>
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
            run({ label: tool.commitLabel, scope: `commit.${tool.id}` }, jobOptions =>
              commitTool(tool.id, jobOptions)
            )
          }
        >
          {busy ? 'Working…' : tool.commitLabel}
        </Button>
      </div>
    </div>
  );
}
