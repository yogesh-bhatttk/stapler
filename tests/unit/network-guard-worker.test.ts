import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cspModule from '../../scripts/csp.mjs';
import {
  WORKER_REMOTE_ALLOWLIST,
  isWorkerRequestAllowed
} from '../../src/core/workers/network-policy';
import { installNetworkGuard, type GuardScope } from '../../src/core/workers/network-guard';
import { resolveModelUrl } from '../../src/core/ocr/model';

/**
 * Audit 2026-10-01 PLT-2 — the website's `<meta>` CSP does not reach its
 * workers, so each worker entry imports `network-guard.ts` first. Its rule
 * is the CSP's `connect-src` without the remote OCR model source: the model
 * is downloaded on the main thread, never in a worker.
 */
const { OCR_MODEL_CONNECT_SOURCES } = cspModule as { OCR_MODEL_CONNECT_SOURCES: string[] };

const WEB = 'https://stapler.app/assets/render.worker-abc.js';
const EXT = 'chrome-extension://abcdefghijklmnop/assets/render.worker-abc.js';

describe('isWorkerRequestAllowed', () => {
  it('allows no remote source at all — stricter than the CSP, never looser', () => {
    expect(WORKER_REMOTE_ALLOWLIST).toEqual([]);
    for (const prefix of WORKER_REMOTE_ALLOWLIST) {
      expect(OCR_MODEL_CONNECT_SOURCES).toContain(prefix);
    }
    // The model is fetched by ocr/download.ts on the main thread, not here.
    expect(isWorkerRequestAllowed(resolveModelUrl('eng'), WEB)).toBe(false);
  });

  it('honours an explicit pinned prefix, normalized, when one is given', () => {
    const pinned = [...OCR_MODEL_CONNECT_SOURCES];
    expect(isWorkerRequestAllowed(resolveModelUrl('eng'), WEB, pinned)).toBe(true);
    expect(isWorkerRequestAllowed(resolveModelUrl('hin'), WEB, pinned)).toBe(true);
    const [eng] = pinned;
    const host = new URL(eng).origin;
    expect(isWorkerRequestAllowed(`${host}/npm/some-package@1/index.js`, WEB, pinned)).toBe(false);
    expect(isWorkerRequestAllowed(`${eng}../../evil@1/x.js`, WEB, pinned)).toBe(false);
    expect(isWorkerRequestAllowed(`${eng.slice(0, -1)}-evil/x`, WEB, pinned)).toBe(false);
  });

  it('allows same-origin, blob: and data: — what pdf.js, zxing and tesseract load', () => {
    expect(isWorkerRequestAllowed('/pdfjs/cmaps/UniJIS-UCS2-H.bcmap', WEB)).toBe(true);
    expect(isWorkerRequestAllowed('./zxing_reader.wasm', WEB)).toBe(true);
    expect(isWorkerRequestAllowed('https://stapler.app/ocr/worker.min.js', WEB)).toBe(true);
    expect(isWorkerRequestAllowed('blob:https://stapler.app/1234', WEB)).toBe(true);
    expect(isWorkerRequestAllowed('data:application/octet-stream;base64,AA==', WEB)).toBe(true);
    // Inside the extension, same-origin is the extension's own package.
    expect(isWorkerRequestAllowed('/pdfjs/standard_fonts/FoxitSans.pfb', EXT)).toBe(true);
    expect(isWorkerRequestAllowed('chrome-extension://other/x.js', EXT)).toBe(false);
  });

  it('refuses every other origin, scheme or port', () => {
    expect(isWorkerRequestAllowed('https://example.com/from-worker', WEB)).toBe(false);
    expect(isWorkerRequestAllowed('http://stapler.app/x', WEB)).toBe(false);
    expect(isWorkerRequestAllowed('https://stapler.app:8443/x', WEB)).toBe(false);
    expect(isWorkerRequestAllowed('wss://stapler.app/socket', WEB)).toBe(false);
    expect(isWorkerRequestAllowed('//evil.example/x', WEB)).toBe(false);
  });

  it('refuses what it cannot parse', () => {
    expect(isWorkerRequestAllowed('https://[bad', WEB)).toBe(false);
    expect(isWorkerRequestAllowed('/x', 'not a base')).toBe(false);
  });
});

function fakeWorkerScope() {
  const fetch = vi.fn(async (input: unknown) => ({ ok: true, input }));
  const opened: unknown[] = [];
  class XMLHttpRequest {
    open(...args: unknown[]) {
      opened.push(args[1]);
    }
  }
  const imported: unknown[] = [];
  const scope: GuardScope = {
    location: { href: WEB },
    fetch,
    XMLHttpRequest,
    importScripts: (...urls: unknown[]) => void imported.push(...urls),
    WebSocket: class {},
    EventSource: class {}
  };
  return { scope, fetch, opened, imported };
}

describe('installNetworkGuard', () => {
  it('passes allowed fetches through to the real fetch and rejects the rest', async () => {
    const { scope, fetch } = fakeWorkerScope();
    installNetworkGuard(scope);
    const guarded = scope.fetch as (input: unknown, init?: unknown) => Promise<unknown>;

    await expect(guarded('/pdfjs/cmaps/x.bcmap')).resolves.toMatchObject({ ok: true });
    await expect(guarded({ url: 'blob:https://stapler.app/1' })).resolves.toMatchObject({
      ok: true
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(guarded('https://example.com/from-worker')).rejects.toThrow(TypeError);
    await expect(guarded({ url: 'https://example.com/req' })).rejects.toThrow(/blocked/);
    await expect(guarded(resolveModelUrl('eng'))).rejects.toThrow(TypeError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('guards XMLHttpRequest#open and importScripts', () => {
    const { scope, opened, imported } = fakeWorkerScope();
    installNetworkGuard(scope);
    const Xhr = scope.XMLHttpRequest as new () => { open(...args: unknown[]): void };

    new Xhr().open('GET', '/pdfjs/iccs/x.icc');
    expect(opened).toEqual(['/pdfjs/iccs/x.icc']);
    expect(() => new Xhr().open('GET', 'https://example.com/x')).toThrow(TypeError);
    expect(opened).toHaveLength(1);

    const importScripts = scope.importScripts as (...urls: string[]) => void;
    importScripts('/ocr/worker.min.js');
    expect(imported).toEqual(['/ocr/worker.min.js']);
    expect(() => importScripts('/ocr/a.js', 'https://example.com/b.js')).toThrow(TypeError);
    expect(imported).toHaveLength(1);
  });

  it('refuses WebSocket and EventSource outright', () => {
    const { scope } = fakeWorkerScope();
    installNetworkGuard(scope);
    expect(() => new (scope.WebSocket as new (u: string) => unknown)('wss://stapler.app/')).toThrow(
      TypeError
    );
    expect(() => new (scope.EventSource as new (u: string) => unknown)('/events')).toThrow(
      TypeError
    );
  });

  it('cannot be undone by reassigning the globals', () => {
    const { scope, fetch } = fakeWorkerScope();
    installNetworkGuard(scope);
    const guarded = scope.fetch;
    expect(() => {
      'use strict';
      scope.fetch = fetch;
    }).toThrow(TypeError);
    expect(scope.fetch).toBe(guarded);
    // A second install is a no-op, not a double wrap.
    installNetworkGuard(scope);
    expect(scope.fetch).toBe(guarded);
  });

  it('does not touch the realm it is merely imported into (not a worker)', () => {
    expect(typeof globalThis.fetch).toBe('function');
    expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.writable).not.toBe(false);
  });
});

describe('every worker entry imports the guard first', () => {
  const dir = path.resolve(__dirname, '../../src/core/workers');
  for (const name of ['convert', 'cv', 'image', 'ocr', 'process', 'render']) {
    it(`${name}.worker.ts`, () => {
      const source = readFileSync(path.join(dir, `${name}.worker.ts`), 'utf8');
      const firstImport = source.split('\n').find(line => /^import\b/.test(line));
      expect(firstImport).toMatch(/^import '\.\/network-guard';/);
    });
  }
});
