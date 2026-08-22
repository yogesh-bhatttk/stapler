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
import styles from './SideBySidePanel.module.css';

export function SideBySidePanel() {
  const t = useTranslation();
  const [loading, setLoading] = useState(false);
  const sourceId = sideBySideSourceId.value;
  const compareSource = sourceId ? sources.value[sourceId] : undefined;

  const openSecondFile = async () => {
    try {
      setLoading(true);
      const files = await platform.openFiles({ accept: { 'application/pdf': ['.pdf'] } });
      if (files.length === 0) return;
      const fileObjects = await Promise.all(files.map(f => f.getFile()));
      const { imported, failures } = await importFiles(fileObjects);
      if (imported.length > 0) {
        // Released *after* the new source is registered, not before: the two
        // could be the same id in principle, and releasing first would delete
        // bytes the swap is about to need.
        const previous = sideBySideSourceId.value;
        sideBySideSourceId.value = imported[0].source.id;
        if (previous) releaseSourceIfUnused(previous);
      }
      if (failures.length > 0) logEvent('error', 'side-by-side', failures[0].message);
    } catch (err: unknown) {
      logEvent('error', 'side-by-side', fromUnknown(err).message);
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
      <Button onClick={openSecondFile} disabled={loading}>
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
