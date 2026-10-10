/**
 * AUDIT-2026-10-10 H3 — the save picker needs a click the user just made.
 *
 * `showSaveFilePicker` requires *transient user activation*: a click or key
 * press within the last few seconds (Chromium: about five). Every export
 * that does real work first — compressing, cleaning, resizing an image,
 * writing fast web view, encrypting for Protect — reaches the picker long
 * after the click that started it. The browser then refuses: `SecurityError`,
 * or `NotAllowedError`, which `isAbort` reads as "the user cancelled" — so a
 * finished compression vanished without a word and the user had no idea they
 * had to click anything.
 *
 * The fix is to *ask for* the click when it is missing: a confirm whose
 * "Save…" button is itself the gesture, then the picker straight away inside
 * it. The finished bytes are held meanwhile; the job is never re-run.
 */
import { confirmAction } from '../core/notify';
import { translate } from '../core/i18n';

/** Transient activation lasts ~5 s in Chromium; leave a margin for the picker call itself. */
export const ACTIVATION_WINDOW_MS = 4000;

interface UserActivationLike {
  readonly isActive: boolean;
}

/**
 * The decision, as a pure function. Prefers the browser's own answer
 * (`navigator.userActivation.isActive`, Chromium 72+, Firefox 120+, Safari
 * 16.4+); without it, the time since the last activating input this page
 * saw. With neither, it cannot tell, and the picker is tried — a refusal is
 * still caught afterwards ({@link isActivationRefusal}).
 */
export function needsFreshActivation(
  userActivation: UserActivationLike | undefined,
  lastActivationAt: number | null,
  now: number
): boolean {
  if (userActivation) return !userActivation.isActive;
  if (lastActivationAt === null) return false;
  return now - lastActivationAt > ACTIVATION_WINDOW_MS;
}

/**
 * A picker refused for want of a gesture. `AbortError` (the user closed the
 * picker) is a real cancel and is not this.
 */
export function isActivationRefusal(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'SecurityError' || err.name === 'NotAllowedError')
  );
}

let lastActivationAt: number | null = null;

/** The events that grant transient activation (HTML §6.4.3, "activation triggering input"). */
const ACTIVATING_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'];

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  for (const type of ACTIVATING_EVENTS) {
    window.addEventListener(
      type,
      event => {
        if (event.isTrusted) lastActivationAt = Date.now();
      },
      { capture: true, passive: true }
    );
  }
}

function currentUserActivation(): UserActivationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { userActivation?: UserActivationLike }).userActivation;
}

/** True when a picker opened now would be refused for want of a fresh click. */
export function activationExpired(): boolean {
  return needsFreshActivation(currentUserActivation(), lastActivationAt, Date.now());
}

/**
 * Asks for the click a picker needs. Resolves true once the user clicked
 * "Save…" — the caller then opens the picker at once, inside that gesture —
 * and false when they chose not to save. `fileName` null: the files are
 * going to a folder the user is about to pick.
 */
export function requestFreshActivation(fileName: string | null): Promise<boolean> {
  if (fileName === null) {
    return confirmAction({
      title: translate('Your files are ready'),
      body: translate(
        'Your browser only opens the folder dialog right after a click. Choose a folder to save them in.'
      ),
      confirmLabel: translate('Choose folder…'),
      cancelLabel: translate('Don’t save'),
      initialFocus: 'confirm'
    });
  }
  return confirmAction({
    title: translate('{name} is ready', { name: fileName }),
    body: translate(
      'Your browser only opens the save dialog right after a click. Choose Save to pick where it goes.'
    ),
    confirmLabel: translate('Save…'),
    cancelLabel: translate('Don’t save'),
    initialFocus: 'confirm'
  });
}

/**
 * Runs `openPicker` — a save or folder picker, or a `requestPermission`
 * prompt, which needs a gesture just the same — with a usable gesture: asks
 * for one first when the last click is too old, and asks once more if the
 * browser refuses anyway. Resolves `null` when the user declined to save.
 * `fileName` null names a folder save (see {@link requestFreshActivation}).
 */
export async function withUserActivation<T>(
  fileName: string | null,
  openPicker: () => Promise<T>,
  hooks: {
    expired?: () => boolean;
    request?: (fileName: string | null) => Promise<boolean>;
  } = {}
): Promise<T | null> {
  const expired = hooks.expired ?? activationExpired;
  const request = hooks.request ?? requestFreshActivation;
  if (expired() && !(await request(fileName))) return null;
  try {
    return await openPicker();
  } catch (err) {
    if (!isActivationRefusal(err)) throw err;
    // The heuristic said the gesture was fresh, and the browser disagreed
    // (focus moved to another window, say). One more explicit click.
    if (!(await request(fileName))) return null;
    return openPicker();
  }
}
