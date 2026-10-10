/**
 * DS-01 theme resolution: stored setting → `prefers-color-scheme` → light.
 *
 * Two bugs this replaces. The old TopBar set `data-theme` inside an effect, so the
 * first paint used the default theme and dark-mode users saw a white flash; and its
 * `matchMedia` listener overwrote a manual choice, so toggling to light and then
 * changing an OS setting silently undid the user's decision. The command palette
 * also toggled by removing the attribute entirely, which is a third state the CSS
 * does not define.
 *
 * `applyStoredTheme` runs before render (see app.tsx) so there is no flash.
 */
import { signal } from '@preact/signals';
import { readSetting, writeSetting } from '../core/db';

export type ThemePreference = 'light' | 'dark' | 'system';

const SETTING_KEY = 'theme';

export const themePreference = signal<ThemePreference>('system');
/** The theme actually painted, after resolving `system`. */
export const resolvedTheme = signal<'light' | 'dark'>('light');

// Cached rather than reconstructed on every call: `window.matchMedia(...)`
// returns a fresh `MediaQueryList` each time, and one with nothing else
// holding a reference to it can be garbage-collected in Safari/WebKit —
// which silently detaches whatever `addEventListener('change', …)` was
// attached to it, so the theme stops following OS changes with no error
// anywhere. Keeping the single instance alive for the module's lifetime
// keeps its listener alive too.
let mediaQuery: MediaQueryList | null | undefined;

const media = (): MediaQueryList | null => {
  if (mediaQuery === undefined) {
    mediaQuery =
      typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)');
  }
  return mediaQuery;
};

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return media()?.matches ? 'dark' : 'light';
}

function paint(theme: 'light' | 'dark') {
  resolvedTheme.value = theme;
  // Always set the attribute — never remove it — so `[data-theme='light']` and the
  // bare `:root` cannot disagree.
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  syncThemeColor();
}

/**
 * The browser-chrome `theme-color` follows the painted theme's `--canvas`
 * token. It used to be a hardcoded `#ffffff` in `editor.html` — a raw colour
 * outside tokens.css that was also wrong in dark mode (audit 2026-09-25 PLT-6).
 * A `<meta>` cannot read a CSS variable, so the resolved value is copied in.
 */
function syncThemeColor() {
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  if (!canvas) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = canvas;
}

/**
 * Applies the stored preference synchronously enough to avoid a flash. The stored
 * value is read from IndexedDB, which is async, so the OS preference is painted
 * first and the stored one takes over on the next microtask — a dark-mode user
 * never sees white.
 */
export function initTheme(): void {
  paint(resolve('system'));

  const listener = () => {
    if (themePreference.value === 'system') paint(resolve('system'));
  };
  media()?.addEventListener('change', listener);

  void readSetting<ThemePreference>(SETTING_KEY).then(stored => {
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      themePreference.value = stored;
      paint(resolve(stored));
    }
  });
}

export function setTheme(preference: ThemePreference): void {
  themePreference.value = preference;
  paint(resolve(preference));
  void writeSetting(SETTING_KEY, preference);
}

/**
 * The preference the top bar's theme button moves to next. `system` was
 * unreachable once left (AUDIT-2026-10-10 UI25); the button now cycles through
 * all three, starting with the theme you are *not* seeing so the first click
 * always changes the screen: system → the opposite of what the OS shows → the
 * OS's own theme pinned explicitly → system.
 */
export function nextThemePreference(
  preference: ThemePreference,
  systemTheme: 'light' | 'dark'
): ThemePreference {
  const opposite = systemTheme === 'dark' ? 'light' : 'dark';
  if (preference === 'system') return opposite;
  if (preference === opposite) return systemTheme;
  return 'system';
}

/** The OS's theme, whatever the stored preference. */
export function systemTheme(): 'light' | 'dark' {
  return resolve('system');
}

/** Moves to {@link nextThemePreference}. */
export function cycleTheme(): void {
  setTheme(nextThemePreference(themePreference.value, systemTheme()));
}

/** Toggles between explicit light and dark, leaving `system` behind on first use. */
export function toggleTheme(): void {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark');
}
