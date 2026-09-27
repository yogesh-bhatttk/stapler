/**
 * DS-07 — the trust panel behind the offline chip.
 *
 * Every claim here has to be true and checkable (PLAN §5.5, DIST-01). The repo link
 * is the only outbound thing in the app, and it is a user-initiated navigation rather
 * than a request the page makes.
 */
import { ShieldCheck } from 'lucide-preact';
import { forwardRef } from 'preact/compat';
import { Modal } from './Modal';
import { platform } from '../../platform/current';
import styles from './InfoModals.module.css';
import { useTranslation } from '../../core/i18n';
import { LocalDataSection } from './LocalDataSection';

export const REPOSITORY_URL = 'https://github.com/stapler-pdf/stapler';

export const TrustModal = forwardRef<HTMLDivElement, { onClose: () => void }>(function TrustModal(
  { onClose },
  ref
) {
  const t = useTranslation();
  return (
    <Modal
      ref={ref}
      title={t('Zero network. Zero tracking.')}
      icon={<ShieldCheck size={20} aria-hidden="true" />}
      onClose={onClose}
      size="md"
    >
      <div className={styles.grid}>
        <p className={styles.pointBody}>
          {t(
            'Stapler does all its work in this {place}. Your documents are never uploaded, there is no account, and there is no size limit or watermark. The extension ships with no permissions at all, which is why installing it shows no warnings.',
            { place: platform.kind === 'extension' ? t('extension page') : t('tab') }
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

        <LocalDataSection />

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
        <p>
          <a
            className={styles.link}
            href="THIRD_PARTY_LICENSES.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('Third-party licenses →')}
          </a>
        </p>
      </div>
    </Modal>
  );
});
