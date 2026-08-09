/**
 * DS-07 — the trust panel behind the offline chip.
 *
 * Every claim here has to be true and checkable (PLAN §5.5, DIST-01). The repo link
 * is the only outbound thing in the app, and it is a user-initiated navigation rather
 * than a request the page makes.
 */
import { ShieldCheck } from 'lucide-preact';
import { Modal } from './Modal';
import { platform } from '../../platform/current';
import styles from './InfoModals.module.css';
import { useTranslation } from '../../core/i18n';

export const REPOSITORY_URL = 'https://github.com/stapler-pdf/stapler';

export function TrustModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  return (
    <Modal
      title={t('Zero network. Zero tracking.')}
      icon={<ShieldCheck size={20} aria-hidden="true" />}
      onClose={onClose}
      size="md"
    >
      <div className={styles.grid}>
        <p className={styles.pointBody}>
          {t('Stapler does all its work in this')}{' '}
          {platform.kind === 'extension' ? 'extension page' : 'tab'}
          {t(
            '. Your documents are never uploaded, there is no account, and there is no size limit or watermark. The extension ships with no permissions at all, which is why installing it shows no warnings.'
          )}
        </p>

        <div className={styles.callout}>
          <strong>{t('Check it yourself:')}</strong>
          <ol className={styles.steps}>
            <li>{t('Open DevTools (F12, or ⌥⌘I on a Mac).')}</li>
            <li>{t('Go to the Network tab and clear it.')}</li>
            <li>{t('Use any tool. No request to any server appears — only local files.')}</li>
          </ol>
        </div>

        <p className={styles.pointBody}>
          {t(
            'The same check runs automatically in CI on every change, so it cannot regress unnoticed. The source is public and MIT-licensed.'
          )}
        </p>

        <p>
          <a
            className={styles.link}
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('Read the source →')}
          </a>
        </p>
        <p>
          <a className={styles.link} href="privacy.html" target="_blank" rel="noopener noreferrer">
            {t('Read the full privacy policy →')}
          </a>
        </p>
      </div>
    </Modal>
  );
}
