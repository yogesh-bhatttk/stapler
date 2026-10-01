/**
 * GAP-2 — page side of the web build's service worker: registration and the
 * "new version available" hand-over.
 *
 * A new deploy installs in the background and then *waits*: the running tab
 * keeps its code (and its open documents) until the user chooses to reload.
 * `onUpdateReady` is how the UI offers that; calling the `apply` it receives
 * tells the waiting worker to take over, and the page reloads once it has.
 *
 * Audit 2026-10-01 PLT-4: that switch moves *every* open tab to the new
 * version's worker, not just the one where the user chose to reload. A tab
 * that did not ask is told through `onReplacedElsewhere`, so it can reload
 * too (or, with unsaved changes, ask first) instead of running old code
 * against a cache that is going away.
 */
import { CLIENT_READY_MESSAGE, SKIP_WAITING_MESSAGE } from './sw-routing';

/** The slices of the Service Worker API used here, so tests can pass fakes. */
export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  /** Absent on fakes that predate it; a real registration always has it. */
  readonly active?: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

export interface ContainerLike {
  readonly controller: { postMessage(message: unknown): void } | null;
  register(url: string, options?: { scope?: string }): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface RegisterOptions {
  container: ContainerLike;
  /** The worker script's URL, e.g. `/sw.js`. */
  url: string;
  scope?: string;
  onUpdateReady: (apply: () => void) => void;
  reload: () => void;
  /**
   * A newer version took over because the user applied it in another tab
   * (PLT-4). Defaults to `reload`.
   */
  onReplacedElsewhere?: () => void;
}

export async function registerServiceWorker(options: RegisterOptions): Promise<RegistrationLike> {
  const { container, onUpdateReady, reload } = options;
  const onReplacedElsewhere = options.onReplacedElsewhere ?? reload;
  let applying = false;
  let handled = false;
  let offered: WorkerLike | null = null;
  // Whether this page was loaded under a worker. The first install also fires
  // `controllerchange` (the new worker claims the page) and must not reload.
  let controlled = Boolean(container.controller);
  // Whether a worker was already active when this page registered. A page can
  // be uncontrolled even then — a hard reload (Shift+F5) bypasses the worker —
  // and for such a page the first `controllerchange` is not the first install
  // but a newer version, applied in another tab, taking over (PLT-4).
  let activeAtLoad = false;

  container.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      if (!activeAtLoad) return;
    }
    if (handled) return;
    handled = true;
    if (applying) reload();
    else onReplacedElsewhere();
  });

  const offer = (worker: WorkerLike) => {
    // With no controller this is the first install, not an update.
    if (!container.controller || offered === worker) return;
    offered = worker;
    onUpdateReady(() => {
      applying = true;
      worker.postMessage({ type: SKIP_WAITING_MESSAGE });
    });
  };

  const registration = await container.register(options.url, { scope: options.scope });
  activeAtLoad = Boolean(registration.active);
  // Lets the worker drop a previous version's cache it kept for tabs that
  // have since reloaded (PLT-4).
  container.controller?.postMessage({ type: CLIENT_READY_MESSAGE });
  if (registration.waiting) offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') offer(worker);
    });
  });
  return registration;
}
