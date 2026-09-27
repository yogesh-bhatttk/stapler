/**
 * GAP-7 — `#/whats-new`, opened by the service worker once per updated
 * version that has release notes (see `shouldShowWhatsNew`). Also reachable
 * directly; it lists every release in `RELEASES`, newest first.
 */
import { useEffect, useRef } from 'preact/hooks';
import { Sparkles } from 'lucide-preact';
import { useTranslation } from '../../core/i18n';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { RELEASES } from './releases';
import styles from './WhatsNewView.module.css';

export function WhatsNewView() {
  const t = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The tab opens on its own after an update, so move focus to the heading
  // for a screen-reader user to hear where they landed.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div>
          <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
            <Icon icon={Sparkles} size={20} />
            {t('What’s new in Stapler')}
          </h1>
          <p className={styles.subtitle}>
            {t('Here is what changed recently. Everything still runs on this device.')}
          </p>
        </div>

        {RELEASES.map((release, index) => (
          <section
            key={release.version}
            className={`${styles.release} ${index === 0 ? styles.latest : ''}`}
            aria-labelledby={`release-${release.version}`}
          >
            <h2 className={styles.version} id={`release-${release.version}`}>
              {t('Version {version}', { version: release.version })}
            </h2>
            <ul className={styles.items}>
              {release.items.map(item => (
                <li key={item}>{t(item)}</li>
              ))}
            </ul>
          </section>
        ))}

        <div>
          <Button variant="secondary" onClick={() => (window.location.hash = '#/')}>
            {t('Go home')}
          </Button>
        </div>
      </div>
    </div>
  );
}
