import { translate } from '../../core/i18n';
import { Moon, Search, Sun } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { TrustModal } from '../components/TrustModal';
import { FileTabs } from './FileTabs';
import { isCommandPaletteOpen } from '../../core/ui';
import { resolvedTheme, toggleTheme } from '../theme';
import { useTranslation, currentLocale, setLocale, locales } from '../../core/i18n';
import styles from './TopBar.module.css';

/** ⌘ on Apple platforms, Ctrl everywhere else — the hint must match the key. */
const MOD_LABEL =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent)
    ? '⌘K'
    : 'Ctrl K';

export function TopBar() {
  const [showTrust, setShowTrust] = useState(false);
  const isDark = resolvedTheme.value === 'dark';
  const t = useTranslation();

  return (
    <header className={styles.topBar}>
      <a href="#/" className={styles.logo}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 8h14" />
          <path d="M5 12h14" />
          <path d="M5 16h14" />
        </svg>
        {t('header.title')}
      </a>

      <FileTabs />

      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="compact"
          icon={Search}
          // This control had no handler at all before: it rendered the shortcut
          // hint as decoration and could not open anything.
          onClick={() => (isCommandPaletteOpen.value = true)}
        >
          <span className={styles.shortcut}>{MOD_LABEL}</span>
        </Button>
        <IconButton
          icon={isDark ? Sun : Moon}
          onClick={toggleTheme}
          size="compact"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        />
        <select
          value={currentLocale.value}
          onChange={e =>
            setLocale(
              (e.currentTarget as HTMLSelectElement).value as Parameters<typeof setLocale>[0]
            )
          }
          style={{
            background: 'transparent',
            color: 'inherit',
            border: '1px solid var(--hairline)',
            borderRadius: '4px',
            padding: '4px',
            // The dropdown's popup is a separate, OS-rendered surface — it doesn't
            // inherit `--ink`/`--surface` at all. Without this, the popup falls back
            // to a light background while `--ink` forces near-white option text in
            // dark mode, so every unselected row is invisible white-on-white.
            colorScheme: isDark ? 'dark' : 'light'
          }}
          aria-label={translate('Change Language')}
        >
          {locales.map(loc => (
            <option key={loc} value={loc}>
              {loc.toUpperCase()}
            </option>
          ))}
        </select>
        {/* DS-07: the claim is the product, so this is a real button on every route. */}
        <button
          type="button"
          className={styles.trustChip}
          onClick={() => setShowTrust(true)}
          aria-label={translate('Offline, zero network requests. Read how to verify this.')}
        >
          <Badge variant="success">{t('Offline · 0 requests')}</Badge>
        </button>
      </div>

      {showTrust && <TrustModal onClose={() => setShowTrust(false)} />}
    </header>
  );
}
