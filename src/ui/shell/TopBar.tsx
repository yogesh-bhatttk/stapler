import { House, Menu, Moon, Search, ShieldCheck, Sun } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { TrustModal } from '../components/TrustModal';
import { FloatingTooltip, useTooltipTrigger } from '../components/FloatingTooltip';
import { FileTabs } from './FileTabs';
import { ToolsSheet } from './ToolsSheet';
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
  const [showTools, setShowTools] = useState(false);
  const trustTooltip = useTooltipTrigger();
  const trustTooltipId = useId();
  const isDark = resolvedTheme.value === 'dark';
  const t = useTranslation();
  // PLT-16 — the chip counts this page's disclosed, consented model downloads
  // (the only request Stapler can ever make) instead of always claiming zero.
  const downloads = disclosedDownloads.value;
  const trustText =
    downloads === 0
      ? t('Offline · 0 requests')
      : tPlural('Offline · {count} disclosed downloads', downloads);

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
        {/* Visually hidden below 600px, where the top bar has no room for it. */}
        <span className={styles.wordmark}>{t('header.title')}</span>
      </a>

      {/* GAP-3 — replaces the tool rail below 600px (CSS shows it only there). */}
      <Button
        variant="secondary"
        size="compact"
        icon={Menu}
        className={styles.toolsButton}
        aria-haspopup="dialog"
        aria-expanded={showTools}
        onClick={() => setShowTools(true)}
      >
        {t('Tools')}
      </Button>

      <FileTabs />

      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="compact"
          icon={Search}
          // This control had no handler at all before: it rendered the shortcut
          // hint as decoration and could not open anything.
          onClick={() => (isCommandPaletteOpen.value = true)}
          // The visible hint is only the key chord, and it is hidden on touch
          // screens (GAP-3), so the name has to come from here.
          aria-label={translate('Command palette')}
          aria-keyshortcuts={MOD_LABEL === '⌘K' ? 'Meta+K' : 'Control+K'}
        >
          <span className={styles.shortcut} aria-hidden="true">
            {MOD_LABEL}
          </span>
        </Button>
        <IconButton
          icon={isDark ? Sun : Moon}
          onClick={toggleTheme}
          size="compact"
          aria-label={isDark ? t('Switch to light theme') : t('Switch to dark theme')}
        />
        <select
          value={currentLocale.value}
          // setLocale never rejects: a dictionary that fails to load leaves the
          // current locale in place.
          onChange={e =>
            void setLocale(
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
          // UI-11: no aria-describedby — the bubble only repeats the claim the
          // accessible name already carries, so describing it would read it twice.
          {...trustTooltip.triggerProps}
        >
          {/* Below 600px the chip collapses to its shield (GAP-3); the full
              claim stays in the accessible name and the tooltip. */}
          <Badge variant="success" className={styles.trustFull}>
            {trustText}
          </Badge>
          <Badge variant="success" className={styles.trustCompact}>
            <Icon icon={ShieldCheck} size={14} />
          </Badge>
        </button>
        <FloatingTooltip anchor={trustTooltip.anchor} id={trustTooltipId} side="block-end">
          {trustText}
        </FloatingTooltip>
      </div>

      {showTrust && <TrustModal onClose={() => setShowTrust(false)} />}
      {showTools && <ToolsSheet onClose={() => setShowTools(false)} />}
    </header>
  );
}
