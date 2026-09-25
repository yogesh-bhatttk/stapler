/**
 * AUDIT-2026-09-25 UI-8 — text generated inside a worker is in the user's
 * language.
 *
 * Workers never loaded a dictionary, so every converter note, progress label
 * and error detail produced there was English whatever the app locale. Each
 * worker API now has `setLocale`, and the pool client sends the app locale to
 * every instance when it spawns and whenever it changes — and holds the first
 * call on a new instance until the locale has been applied.
 *
 * Two halves are tested: the worker side (a real worker API implementation,
 * driven directly, speaks German after `setLocale('de')` and follows later
 * changes), and the client side (a real Comlink round trip through a
 * `MessageChannel`, checking what the worker is told and when).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentLocale, type Locale } from '../../src/core/i18n';

// The worker modules call `Comlink.expose(api)` on import, which needs a worker
// global Node does not have. Only that no-endpoint call is stubbed: the client
// tests below still use real Comlink over a MessageChannel.
vi.mock('comlink', async importOriginal => {
  const actual = await importOriginal<typeof import('comlink')>();
  return {
    ...actual,
    expose: (value: unknown, endpoint?: Comlink.Endpoint) =>
      endpoint ? actual.expose(value, endpoint) : undefined
  };
});
import { createWorkerClient, type LocaleAware } from '../../src/core/workers/client';
import { convertWorkerImpl } from '../../src/core/workers/convert.worker';
import { XLSX_EMPTY_MESSAGE, hiddenRowsNote } from '../../src/core/convert/xlsx-reader';

const LOCALES = path.resolve(__dirname, '../../src/core/i18n/locales');

function dictionary(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, `${locale}.json`), 'utf8')) as Record<
    string,
    string
  >;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to reject');
}

afterEach(async () => {
  await convertWorkerImpl.setLocale('en');
  currentLocale.value = 'en';
});

describe('worker-side translation (UI-8)', () => {
  it('throws its error detail in German after setLocale("de"), and follows a later change', async () => {
    expect(await convertWorkerImpl.setLocale('de')).toBe(true);
    const german = await rejection(convertWorkerImpl.xlsxToBlocks(new Uint8Array()));
    const de = dictionary('de')[XLSX_EMPTY_MESSAGE];
    expect(de).toBeTruthy();
    expect(de).not.toBe(XLSX_EMPTY_MESSAGE);
    expect(german.message).toBe(de);

    await convertWorkerImpl.setLocale('fr');
    const french = await rejection(convertWorkerImpl.xlsxToBlocks(new Uint8Array()));
    expect(french.message).toBe(dictionary('fr')[XLSX_EMPTY_MESSAGE]);
    expect(french.message).not.toBe(german.message);

    await convertWorkerImpl.setLocale('en');
    const english = await rejection(convertWorkerImpl.xlsxToBlocks(new Uint8Array()));
    expect(english.message).toBe(XLSX_EMPTY_MESSAGE);
  });

  it('picks the plural form the worker locale needs (Russian "few", Arabic "two")', async () => {
    const key =
      '{count} hidden rows in sheet "{sheet}" were left out, the same way Excel itself does ' +
      'not print them.';
    await convertWorkerImpl.setLocale('ru');
    expect(hiddenRowsNote('Q1', 3)).toBe(
      dictionary('ru')[`${key}_few`].replace('{count}', '3').replace('{sheet}', 'Q1')
    );
    await convertWorkerImpl.setLocale('ar');
    expect(hiddenRowsNote('Q1', 2)).toBe(
      dictionary('ar')[`${key}_two`].replace('{count}', '2').replace('{sheet}', 'Q1')
    );
    await convertWorkerImpl.setLocale('en');
    expect(hiddenRowsNote('Q1', 1)).toBe(
      '1 hidden row in sheet "Q1" was left out, the same way Excel itself does not print them.'
    );
  });

  it('refuses an unknown locale and keeps the one in effect', async () => {
    await convertWorkerImpl.setLocale('de');
    expect(await convertWorkerImpl.setLocale('xx' as Locale)).toBe(false);
    const err = await rejection(convertWorkerImpl.xlsxToBlocks(new Uint8Array()));
    expect(err.message).toBe(dictionary('de')[XLSX_EMPTY_MESSAGE]);
  });
});

interface FakeApi extends LocaleAware {
  locale(): string;
}

/** One end of a MessageChannel with a Comlink-exposed API on the other, like a worker. */
function spawnFake(log: string[], delayMs = 20): Worker {
  const { port1, port2 } = new MessageChannel();
  let current = 'none';
  const api: FakeApi = {
    async setLocale(locale) {
      // A dictionary import takes a while; the first call must still wait for it.
      await new Promise(resolve => setTimeout(resolve, delayMs));
      log.push(locale);
      current = locale;
      return true;
    },
    locale: () => current
  };
  Comlink.expose(api, port2);
  port1.start();
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      port1.postMessage(message, transfer ?? []),
    addEventListener: (type: string, fn: EventListener) =>
      type === 'error' ? undefined : port1.addEventListener(type, fn),
    removeEventListener: (type: string, fn: EventListener) => port1.removeEventListener(type, fn),
    terminate: () => {
      port1.close();
      port2.close();
    }
  } as unknown as Worker;
}

describe('worker client locale sync (UI-8)', () => {
  it('applies the app locale on spawn before the first call runs', async () => {
    const log: string[] = [];
    currentLocale.value = 'de';
    const client = createWorkerClient<FakeApi>(() => spawnFake(log), {
      syncLocale: true,
      idleMs: 0
    });
    await expect(client.lease(api => api.locale())).resolves.toBe('de');
    expect(log).toEqual(['de']);
    client.terminate();
  });

  it('sends every later change to live instances, in order', async () => {
    const log: string[] = [];
    currentLocale.value = 'en';
    const client = createWorkerClient<FakeApi>(() => spawnFake(log), {
      syncLocale: true,
      idleMs: 0,
      maxSize: 1
    });
    const pinned = client.pin();
    await expect(pinned.lease(api => api.locale())).resolves.toBe('en');

    currentLocale.value = 'fr';
    currentLocale.value = 'ja';
    // Queued behind both changes: the call sees the last one, never a stale one.
    await expect(pinned.lease(api => api.locale())).resolves.toBe('ja');
    expect(log).toEqual(['en', 'fr', 'ja']);
    pinned.release();
    client.terminate();
  });

  it('never calls setLocale on a pool that did not opt in', async () => {
    const log: string[] = [];
    currentLocale.value = 'de';
    const client = createWorkerClient<FakeApi>(() => spawnFake(log), { idleMs: 0 });
    await expect(client.lease(api => api.locale())).resolves.toBe('none');
    expect(log).toEqual([]);
    client.terminate();
  });
});
