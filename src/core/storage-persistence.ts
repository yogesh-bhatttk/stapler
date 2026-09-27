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

async function recordOutcome(outcome: PersistOutcome, trigger: PersistTrigger): Promise<void> {
  const record: PersistenceRecord = { outcome, trigger, at: Date.now() };
  await writeSetting(PERSISTENCE_SETTING_KEY, record);
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
      const prior = await readSetting<PersistenceRecord>(PERSISTENCE_SETTING_KEY);
      if (prior?.outcome) return prior.outcome;
      const outcome = await callPersist(storage);
      await recordOutcome(outcome, trigger);
      if (outcome === 'denied') warnNotPersistent();
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
  await recordOutcome(outcome, 'manual').catch(() => {});
  automaticRequest = Promise.resolve(outcome);
  return outcome;
}

let lastHeadroomCheckAt = -Infinity;
let quotaWarned = false;

/** Formats a byte count for storage figures, up to gigabytes. */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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

/** Test hook: forget this session's request and warnings. */
export function __resetStoragePersistenceForTests(): void {
  automaticRequest = null;
  lastHeadroomCheckAt = -Infinity;
  quotaWarned = false;
}
