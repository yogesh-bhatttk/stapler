/**
 * RT-7 — progress and a working Cancel for the running job, for screens with
 * no action bar (the Home launcher: the drop zone and Recents). On a tool
 * route the action bar already shows both.
 */
import { X } from 'lucide-preact';
import { activeJob } from '../../core/notify';
import { useTranslation } from '../../core/i18n';
import { Button } from './Button';
import { ProgressBar } from './Feedback';
import styles from './JobStatusRow.module.css';

export function JobStatusRow({ showProgress = true }: { showProgress?: boolean }) {
  const t = useTranslation();
  const job = activeJob.value;
  if (!job) return null;
  return (
    <div className={styles.row}>
      {showProgress && (
        <div className={styles.progress}>
          <ProgressBar label={job.label} value={job.progress} />
        </div>
      )}
      <Button variant="tertiary" size="compact" icon={X} onClick={() => job.cancel()}>
        {t('Cancel')}
      </Button>
    </div>
  );
}
