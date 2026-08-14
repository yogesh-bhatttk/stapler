/**
 * Global error hooks, shared by every entry point that mounts `App` (the editor
 * entry and the website-twin landing pages, DIST-03). Without these, a rejected
 * promise in an event handler vanishes into the console and the user is left
 * looking at a control that did nothing (F-07).
 */
import { notifyError } from '../core/notify';

export function installErrorHooks(): void {
  window.addEventListener('unhandledrejection', event => {
    notifyError('unhandled', event.reason);
  });
  window.addEventListener('error', event => {
    if (event.error) notifyError('uncaught', event.error);
  });
}
