/**
 * ANN-07 — pick the second document. The actual synced two-pane view lives in
 * `SideBySideView.tsx`, rendered by `Canvas.tsx` in place of the normal single
 * page view, the same split `compare`/`compress` already use for a fully
 * custom canvas.
 */
import { useState } from 'preact/hooks';
import { platform } from '../../../platform/current';
import { importFiles } from '../../../core/import';
import { logEvent, fromUnknown } from '../../../core/errors';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';
import { sources, releaseSourceIfUnused } from '../../../core/store';
import { sideBySideSourceId } from './state';
import { activeJob, notify, notifyError } from '../../../core/notify';
import { translate } from '../../../core/i18n';
import { discardImported } from '../../../core/open-document';
import { useJob } from '../../useJob';
import styles from './SideBySidePanel.module.css';

export function SideBySidePanel() {
  const t = useTranslation();
  const [loading, setLoading] = useState(false);
  const { run } = useJob();
  const sourceId = sideBySideSourceId.value;
  const compareSource = sourceId ? sources.value[sourceId] : undefined;

  const openSecondFile = async () => {
    // Checked before the picker opens, so a choice is never thrown away (UI-20).
    if (activeJob.value !== null) {
      notify('info', translate('Finish or cancel the current operation first.'));
      return;
    }
    try {
      setLoading(true);
      const files = await platform.openFiles({ accept: { 'application/pdf': ['.pdf'] } });
      if (files.length === 0) return;
      const fileObjects = await Promise.all(files.map(f => f.getFile()));
      // RT-7 — a job with progress and a working Cancel in the action bar.
      await run({ label: translate('Opening document'), scope: 'side-by-side' }, async job => {
        const outcome = await importFiles(fileObjects, job);
        if (job.signal?.aborted) {
          discardImported(outcome);
          return;
        }
        const { imported, failures } = outcome;
        if (imported.length > 0) {
          // Released *after* the new source is registered, not before: the two
          // could be the same id in principle, and releasing first would delete
          // bytes the swap is about to need.
          const previous = sideBySideSourceId.value;
          sideBySideSourceId.value = imported[0].source.id;
          if (previous) releaseSourceIfUnused(previous);
          // Only the first file is shown; the rest are not kept.
          discardImported({ imported: imported.slice(1), failures: [] });
        }
        if (failures.length > 0) {
          logEvent('error', 'side-by-side', failures[0].message);
          notify('danger', translate('Could not open {name}', { name: failures[0].name }), {
            detail: failures[0].message
          });
        }
      });
    } catch (err: unknown) {
      // `run` reports its own failures; this is the picker or reading the file.
      logEvent('error', 'side-by-side', fromUnknown(err).message);
      notifyError('side-by-side.open', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={panelStyles.section}>
      <p className={panelStyles.description}>
        {t(
          'View this document next to another one. Scrolling, page turns, and zoom stay in sync between the two.'
        )}
      </p>
      <Button onClick={() => void openSecondFile()} disabled={loading}>
        {compareSource ? t('Change the other document…') : t('Open a document to view alongside…')}
      </Button>
      {compareSource && (
        <div className={styles.compareRow}>
          <p className={panelStyles.description}>
            {t('Comparing against {name}', { name: compareSource.name })}
          </p>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              const previous = sideBySideSourceId.value;
              sideBySideSourceId.value = null;
              if (previous) releaseSourceIfUnused(previous);
            }}
          >
            {t('Close')}
          </Button>
        </div>
      )}
    </div>
  );
}
