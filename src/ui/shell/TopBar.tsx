import { House, Moon, Search, Sun } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { TrustModal } from '../components/TrustModal';
import { FileTabs } from './FileTabs';
import { isCommandPaletteOpen } from '../../core/ui';
import { disclosedDownloads } from '../../core/disclosedDownloads';
import { resolvedTheme, toggleTheme } from '../theme';
import {
  useTranslation,
  currentLocale,
  setLocale,
  locales,
  tPlural,
  translate
} from '../../core/i18n';
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
  // PLT-16 — the chip counts this page's disclosed, consented model downloads
  // (the only request Stapler can ever make) instead of always claiming zero.
  const downloads = disclosedDownloads.value;

  return (
    <header className={styles.topBar}>
      {/*
       * This link always went to Home (`href="#/"`) — the bug was that the icon
       * next to the wordmark was three horizontal bars, i.e. drawn as a menu
       * toggle, not as a home affordance. A `title` tooltip and a real House
       * icon make the same existing link legible as "click to go home" instead
       * of looking like static branding.
       */}
      <a href="#/" className={styles.logo} title={t('Home')}>
        <Icon icon={House} size={20} />
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
          aria-label={isDark ? t('Switch to light theme') : t('Switch to dark theme')}
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
            // inherit `--ink`/`--surface` at all. `color-scheme` is meant to fix this
            // but native popups on Linux/GTK builds of Chrome ignore it and keep the
            // OS-theme (light) background regardless, so it's not a reliable enough
            // signal on its own here — see the explicit background+color pairing on
            // each option below.
            colorScheme: isDark ? 'dark' : 'light'
          }}
          aria-label={translate('Change Language')}
        >
          {locales.map(loc => (
            <option
              key={loc}
              value={loc}
              // Force background and text together, as a matched pair, instead of just
              // text color: forcing only `--ink` (near-white in dark mode) against
              // whatever background the popup falls back to is what made every
              // unselected row invisible white-on-white in the first place.
              style={{ backgroundColor: 'var(--surface-1)', color: 'var(--ink)' }}
            >
              {loc.toUpperCase()}
            </option>
          ))}
        </select>
        {/* DS-07: the claim is the product, so this is a real button on every route. */}
        <button
          type="button"
          className={styles.trustChip}
          onClick={() => setShowTrust(true)}
          aria-label={
            downloads === 0
              ? translate('Offline, zero network requests. Read how to verify this.')
              : tPlural(
                  'Offline except {count} disclosed model downloads you approved. Read how to verify this.',
                  downloads
                )
          }
        >
          <Badge variant="success">
            {downloads === 0
              ? t('Offline · 0 requests')
              : tPlural('Offline · {count} disclosed downloads', downloads)}
          </Badge>
        </button>
      </div>

      {showTrust && <TrustModal onClose={() => setShowTrust(false)} />}
    </header>
  );
}
