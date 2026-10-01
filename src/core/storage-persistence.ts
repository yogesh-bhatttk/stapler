/**
 * GAP-9 — storage resilience.
 *
 * Everything Stapler keeps between visits — the session-recovery record and
 * the document bytes it points at (OPFS), downloaded OCR models, saved
 * signatures — lives in "best-effort" browser storage by default, which the
 * browser may evict under storage pressure without asking. Two defences:
 *
 *  1. Ask for persistent storage (`navigator.storage.persist()`) — once, and
 *     only after the user has something worth keeping: the first successful
 *     session save or the first OCR model download. The outcome is remembered
 *     in the `settings` store so the browser is never asked again on its own
 *     (Firefox shows a prompt; asking on every save would nag). The trust panel
 *     offers a manual retry.
 *  2. Watch `navigator.storage.estimate()` after those same writes and warn,
 *     once per session, when usage approaches the quota.
 *
 * An extension page is usually persistent already: `persisted()` answering
 * `true` short-circuits the request. `persist()` resolving to anything other
 * than a boolean (seen in embedded/older engines) is treated as "unsupported",
 * never as a denial the user must be warned about.
 *
 * Never throws: every entry point is fire-and-forget from a save path.
 */
import { readSetting, writeSetting } from './db';
import { logEvent } from './errors';
import { notify } from './notify';
import { translate } from './i18n';
import { formatBytes } from './bytes';

export const PERSISTENCE_SETTING_KEY = 'storage.persistence';

export type PersistOutcome = 'granted' | 'denied' | 'unsupported';
export type PersistTrigger = 'session-save' | 'ocr-model' | 'manual';

export interface PersistenceRecord {
  outcome: PersistOutcome;
  trigger: PersistTrigger;
  at: number;
}

/** Usage at or above this share of the quota triggers the "almost full" warning. */
export const QUOTA_WARNING_RATIO = 0.8;
/** `estimate()` is not free; after a write it is consulted at most this often. */
export const HEADROOM_CHECK_INTERVAL_MS = 60_000;

interface StorageManagerLike {
  persist?: () => Promise<unknown>;
  persisted?: () => Promise<unknown>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

function storageManager(): StorageManagerLike | null {
  const storage = (globalThis.navigator as { storage?: StorageManagerLike } | undefined)?.storage;
  return storage ?? null;
}

/** `true`/`false` from `persisted()`, or `null` when the browser cannot say. */
export async function isStoragePersisted(): Promise<boolean | null> {
  const storage = storageManager();
  if (typeof storage?.persisted !== 'function') return null;
  try {
    const value = await storage.persisted();
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

/** `navigator.storage.estimate()`, or `null` when unavailable or meaningless. */
export async function readStorageEstimate(): Promise<StorageEstimate | null> {
  const storage = storageManager();
  if (typeof storage?.estimate !== 'function') return null;
  try {
    const { usage, quota } = await storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

let automaticRequest: Promise<PersistOutcome> | null = null;

/**
 * RT-9 — "asked this session" in `sessionStorage`, independent of IndexedDB.
 * "Ask once" used to rest entirely on the `settings` write: when that write
 * failed, every reload asked `persist()` again (a prompt in Firefox). This
 * flag survives reloads of the tab, holds the answer given, and is written
 * *before* asking, so even a write that fails afterwards cannot cause a
 * second prompt this session. Best-effort: storage access can throw.
 */
const SESSION_FLAG_KEY = 'stapler.persistence.asked';

function readSessionFlag(): PersistOutcome | null {
  try {
    const value = globalThis.sessionStorage?.getItem(SESSION_FLAG_KEY);
    return value === 'granted' || value === 'denied' || value === 'unsupported' ? value : null;
  } catch {
    return null;
  }
}

function writeSessionFlag(outcome: PersistOutcome): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_FLAG_KEY, outcome);
  } catch {
    // No session storage: the in-memory `automaticRequest` still holds for this page.
  }
}

/** Resolves whether the outcome was actually stored (`writeSetting` reports, not throws). */
async function recordOutcome(outcome: PersistOutcome, trigger: PersistTrigger): Promise<boolean> {
  const record: PersistenceRecord = { outcome, trigger, at: Date.now() };
  return writeSetting(PERSISTENCE_SETTING_KEY, record);
}

async function callPersist(storage: StorageManagerLike): Promise<PersistOutcome> {
  try {
    const value = await storage.persist?.();
    return value === true ? 'granted' : value === false ? 'denied' : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

function warnNotPersistent(): void {
  notify('warning', translate('The browser may clear Stapler’s saved data.'), {
    detail: translate(
      'This browser did not make Stapler’s storage persistent, so session-recovery data and stored OCR models can be deleted when space runs low. Export documents you need to keep.'
    )
  });
}

/**
 * Asks for persistent storage at most once, ever (per browser profile): the
 * first call per session decides, and a remembered outcome from an earlier
 * session is reused without asking again. Concurrent calls share one request.
 */
export function requestPersistenceOnce(trigger: PersistTrigger): Promise<PersistOutcome> {
  automaticRequest ??= (async (): Promise<PersistOutcome> => {
    const storage = storageManager();
    if (typeof storage?.persist !== 'function') return 'unsupported';
    try {
      if ((await isStoragePersisted()) === true) {
        const prior = await readSetting<PersistenceRecord>(PERSISTENCE_SETTING_KEY);
        if (prior?.outcome !== 'granted') await recordOutcome('granted', trigger);
        return 'granted';
      }
      const asked = readSessionFlag();
      if (asked) return asked;
      const prior = await readSetting<PersistenceRecord>(PERSISTENCE_SETTING_KEY).catch(
        () => undefined
      );
      if (prior?.outcome) return prior.outcome;
      // Marked before asking: nothing after this line can lead to a second
      // prompt in this session.
      writeSessionFlag('unsupported');
      const outcome = await callPersist(storage);
      writeSessionFlag(outcome);
      const recorded = await recordOutcome(outcome, trigger).catch(() => false);
      if (!recorded) {
        logEvent('warn', 'storage', 'Could not record the persistence outcome');
      }
      // The one-time warning is one-time only if the outcome was remembered;
      // when it could not be, staying quiet beats warning on every visit.
      if (outcome === 'denied' && recorded) warnNotPersistent();
      logEvent('info', 'storage', `Persistent storage ${outcome} (after ${trigger})`);
      return outcome;
    } catch (err) {
      logEvent('warn', 'storage', `Persistence request failed: ${String(err)}`);
      return 'unsupported';
    }
  })();
  return automaticRequest;
}

/**
 * The trust panel's explicit "Ask to keep data" button: a user action, so it
 * asks even when an earlier automatic request was denied, and records the new
 * answer. Returns the outcome (the panel shows it; no toast).
 */
export async function requestPersistenceNow(): Promise<PersistOutcome> {
  const storage = storageManager();
  if (typeof storage?.persist !== 'function') return 'unsupported';
  const outcome = await callPersist(storage);
  writeSessionFlag(outcome);
  await recordOutcome(outcome, 'manual').catch(() => {});
  automaticRequest = Promise.resolve(outcome);
  return outcome;
}

let lastHeadroomCheckAt = -Infinity;
let quotaWarned = false;

/**
 * Formats a byte count for storage figures — the app's one decimal formatter
 * (X-10), so "Local data" and every other size in the app agree.
 */
export function formatStorageBytes(bytes: number): string {
  return formatBytes(bytes);
}

/**
 * Warns once per session when usage reaches {@link QUOTA_WARNING_RATIO} of the
 * quota. Rate-limited so a burst of autosaves costs one `estimate()` a minute.
 * Returns whether the warning was shown by this call.
 */
export async function checkStorageHeadroom(now = Date.now()): Promise<boolean> {
  if (quotaWarned || now - lastHeadroomCheckAt < HEADROOM_CHECK_INTERVAL_MS) return false;
  lastHeadroomCheckAt = now;
  const estimate = await readStorageEstimate();
  if (!estimate || estimate.usage / estimate.quota < QUOTA_WARNING_RATIO) return false;
  quotaWarned = true;
  notify('warning', translate('Browser storage is almost full.'), {
    detail: translate(
      '{used} of {quota} is in use. Session recovery may stop working and the browser may clear stored data. Open the privacy panel from the top bar to see what is stored and free space.',
      { used: formatStorageBytes(estimate.usage), quota: formatStorageBytes(estimate.quota) }
    )
  });
  return true;
}

/** Called after a session record with open documents was written. */
export function noteSessionSaved(): void {
  void requestPersistenceOnce('session-save');
  void checkStorageHeadroom().catch(() => {});
}

/** Called after an OCR language model was stored locally. */
export function noteModelStored(): void {
  void requestPersistenceOnce('ocr-model');
  void checkStorageHeadroom().catch(() => {});
}

/**
 * Test hook: forget this session's request and warnings — a new session, so
 * the `sessionStorage` flag goes too.
 */
export function __resetStoragePersistenceForTests(): void {
  automaticRequest = null;
  try {
    globalThis.sessionStorage?.removeItem(SESSION_FLAG_KEY);
  } catch {
    // ignore
  }
  lastHeadroomCheckAt = -Infinity;
  quotaWarned = false;
}

/** Test hook: a reload — this page's memory is forgotten, the session flag is kept. */
export function __forgetInMemoryRequestForTests(): void {
  automaticRequest = null;
}
