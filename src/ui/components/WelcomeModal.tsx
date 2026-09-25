/**
 * DS-08 — the one-screen first run. Says what the app does and that nothing is
 * uploaded, then gets out of the way for good.
 */
import { Layers, Shield, Zap } from 'lucide-preact';
import { forwardRef } from 'preact/compat';
import { Button } from './Button';
import { Modal } from './Modal';
import styles from './InfoModals.module.css';
import { tKey, useTranslation } from '../../core/i18n';

const POINTS = [
  {
    icon: Shield,
    title: tKey('Nothing leaves your device'),
    body: tKey(
      'No uploads, no account, no telemetry. Open DevTools and watch the Network tab if you would rather check than take our word for it.'
    )
  },
  {
    icon: Layers,
    title: tKey('Merge, split, sign, compress, redact'),
    body: tKey('No file-size cap, no daily limit, no watermark on anything you export.')
  },
  {
    icon: Zap,
    title: tKey('Heavy work stays off the main thread'),
    body: tKey('Long operations report progress and can be cancelled at any point.')
  }
];

export const WelcomeModal = forwardRef<HTMLDivElement, { onClose: () => void }>(
  function WelcomeModal({ onClose }, ref) {
    const t = useTranslation();
    return (
      <Modal
        ref={ref}
        title={t('Welcome to Stapler')}
        onClose={onClose}
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('Get started')}
          </Button>
        }
      >
        <div className={styles.grid}>
          {POINTS.map(point => (
            <div className={styles.point} key={point.title}>
              <span className={styles.pointIcon}>
                <point.icon size={22} aria-hidden="true" />
              </span>
              <div>
                <h3 className={styles.pointTitle}>{t(point.title)}</h3>
                <p className={styles.pointBody}>{t(point.body)}</p>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    );
  }
);
