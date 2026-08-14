/**
 * The root routed component, shared by the extension/editor entry (`app.tsx`) and
 * the website-twin landing pages (`mountLanding.tsx`, DIST-03). Pulled out of
 * `app.tsx` so a landing page can mount exactly this tree — same rail, same canvas,
 * same tool logic — instead of a reimplementation that could drift from the real app.
 *
 * Named `AppRoot` rather than `App` so the file name doesn't collide with
 * `app.tsx` on a case-insensitive filesystem (TS1149) or in a directory listing.
 */
import { Route, Router, Switch } from 'wouter-preact';
import { useHashLocation } from 'wouter-preact/use-hash-location';
import { AppShell } from './shell/AppShell';
import { Canvas } from './shell/Canvas';
import { HomeView } from './home/HomeView';
import { ComponentGallery } from './dev/ComponentGallery';
import { EmptyState } from './components/Feedback';
import { Button } from './components/Button';

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

export function App() {
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
