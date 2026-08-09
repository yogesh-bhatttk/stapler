/**
 * Application entry point.
 *
 * Two things happen before `render`: the theme is painted, so a dark-mode user never
 * sees a white flash (the old code set `data-theme` inside an effect), and the global
 * error hooks are installed so an unhandled rejection becomes a typed message rather
 * than a silent console line.
 */
import { render } from 'preact';
import { Route, Router, Switch } from 'wouter-preact';
import { useHashLocation } from 'wouter-preact/use-hash-location';
import { AppShell } from './shell/AppShell';
import { Canvas } from './shell/Canvas';
import { HomeView } from './home/HomeView';
import { ComponentGallery } from './dev/ComponentGallery';
import { EmptyState } from './components/Feedback';
import { Button } from './components/Button';
import { notifyError } from '../core/notify';
import { initTheme } from './theme';
import { initLocale } from '../core/i18n';
import './styles/tokens.css';

function NotFound() {
  return (
    <EmptyState
      title="Nothing here"
      body="That route does not exist."
      action={
        <Button variant="secondary" onClick={() => (window.location.hash = '#/')}>
          Go home
        </Button>
      }
    />
  );
}

function App() {
  return (
    <Router hook={useHashLocation}>
      <AppShell>
        <Switch>
          <Route path="/" component={HomeView} />
          {/* Not linked from the app; a visual-review surface for DS-03. */}
          <Route path="/dev/components" component={ComponentGallery} />
          {/* Every tool shares one route; the tool registry decides what renders. */}
          <Route path="/tool/:toolId" component={Canvas} />
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </Router>
  );
}

function installErrorHooks() {
  // Without these, a rejected promise in an event handler vanishes into the console
  // and the user is left looking at a control that did nothing (F-07).
  window.addEventListener('unhandledrejection', event => {
    notifyError('unhandled', event.reason);
  });
  window.addEventListener('error', event => {
    if (event.error) notifyError('uncaught', event.error);
  });
}

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
