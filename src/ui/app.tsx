/**
 * Application entry point for `editor.html` (the extension page, and the website
 * twin's own root — see `emitWebIndex` in vite.config.ts).
 *
 * Two things happen before `render`: the theme is painted, so a dark-mode user never
 * sees a white flash (the old code set `data-theme` inside an effect), and the global
 * error hooks are installed so an unhandled rejection becomes a typed message rather
 * than a silent console line.
 *
 * The routed tree itself lives in `App.tsx` and the error hooks in `errorHooks.ts` —
 * split out so the per-tool landing pages (`mountLanding.tsx`, DIST-03) mount the same
 * app instead of a reimplementation.
 */
import { render } from 'preact';
import { App } from './AppRoot';
import { installErrorHooks } from './errorHooks';
import { initTheme } from './theme';
import { initLocale } from '../core/i18n';
import './styles/tokens.css';

const root = document.getElementById('app');
if (!root) throw new Error('The #app mount point is missing from editor.html');

initTheme();
// `initLocale` was defined but never called — the dictionary for every
// locale, including the 'en' default, never loaded on boot. Most `t()` calls
// use the raw English string as their own key, so the "no dictionary loaded"
// fallback (returning the key verbatim) happened to look correct by
// coincidence; any call using a symbolic key (`t('header.title')` and every
// key this audit added) rendered its literal dotted key instead of real text
// until the user manually touched the language switcher once.
void initLocale();
installErrorHooks();
render(<App />, root);
