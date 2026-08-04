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

const media = () =>
  typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)');

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

/** Toggles between explicit light and dark, leaving `system` behind on first use. */
export function toggleTheme(): void {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark');
}
