/**
 * GAP-7 — the one message the service worker sends an editor tab: "switch to
 * this route". Shared by the sender (`background/service-worker.ts`) and the
 * receiver (`platform/extension.ts`) so the shape cannot drift between them.
 */
import { isInternalRoute } from './omnibox';

export const NAVIGATE_MESSAGE = 'stapler:navigate';

export interface NavigateMessage {
  type: typeof NAVIGATE_MESSAGE;
  /** A hash route such as `/tool/merge`; see `isInternalRoute`. */
  route: string;
  /** The editor tab meant to act on it — every open extension page receives it. */
  tabId: number;
}

export function isNavigateMessage(value: unknown): value is NavigateMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<NavigateMessage>;
  return (
    message.type === NAVIGATE_MESSAGE &&
    typeof message.tabId === 'number' &&
    isInternalRoute(message.route)
  );
}
