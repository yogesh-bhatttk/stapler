/**
 * GAP-2 — page side of the web build's service worker: registration and the
 * "new version available" hand-over.
 *
 * A new deploy installs in the background and then *waits*: the running tab
 * keeps its code (and its open documents) until the user chooses to reload.
 * `onUpdateReady` is how the UI offers that; calling the `apply` it receives
 * tells the waiting worker to take over, and the page reloads once it has.
 */
import { SKIP_WAITING_MESSAGE } from './sw-routing';

/** The slices of the Service Worker API used here, so tests can pass fakes. */
export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

export interface ContainerLike {
  readonly controller: unknown;
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
}

export async function registerServiceWorker(options: RegisterOptions): Promise<RegistrationLike> {
  const { container, onUpdateReady, reload } = options;
  let applying = false;
  let reloaded = false;
  let offered: WorkerLike | null = null;

  container.addEventListener('controllerchange', () => {
    // Only a switch the user asked for reloads the page. The first install
    // also fires this (the new worker claims the page) and must not.
    if (!applying || reloaded) return;
    reloaded = true;
    reload();
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
