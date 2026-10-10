import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Audit 2026-09-25 PLT-7 / M4 — fixtures that load the packaged extension
 * (`dist/ext`) into Chromium and watch everything that page does.
 *
 * Every other e2e spec runs against `vite preview` of the web target: no MV3
 * CSP, a different origin, and test hooks compiled in. That is how CONV-1
 * shipped. These run the artifact that goes to the store.
 */
export const EXTENSION_DIR = path.resolve(process.cwd(), process.env.STAPLER_EXT_DIR ?? 'dist/ext');

export interface Diagnostics {
  /** Every request to anything but the extension's own package, blob: or data:. */
  external: string[];
  /** `Refused to …` console messages and `securitypolicyviolation` events. */
  cspViolations: string[];
  /** Uncaught exceptions and unhandled rejections on any page. */
  pageErrors: string[];
  /** Every `console.error` on any page. */
  consoleErrors: string[];
}

interface Fixtures {
  diagnostics: Diagnostics;
  extensionId: string;
  /** A tab showing the extension's editor, first-run dialog dismissed. */
  editor: Page;
}

/** Stripped before any app script runs, as in helpers.ts — Playwright cannot drive native FSA pickers. */
function forceFileInputFallback() {
  delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
}

function recordCspEvents() {
  const w = window as unknown as { __cspViolations: string[] };
  w.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => {
    w.__cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
  });
}

function watch(page: Page, diagnostics: Diagnostics) {
  page.on('pageerror', error => diagnostics.pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    diagnostics.consoleErrors.push(text);
    if (/Content Security Policy|Refused to/i.test(text)) diagnostics.cspViolations.push(text);
  });
}

export const test = base.extend<Fixtures & { context: BrowserContext }>({
  // Playwright requires an object pattern here even when no fixture is used.
  // eslint-disable-next-line no-empty-pattern
  diagnostics: async ({}, use) => {
    await use({ external: [], cspViolations: [], pageErrors: [], consoleErrors: [] });
  },

  // A fresh profile per test: first-run state, IndexedDB and OPFS all start
  // empty, just as for a new install.
  context: async ({ diagnostics }, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'stapler-ext-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // The full `chromium` channel, not headless-shell: only it loads extensions.
      channel: 'chromium',
      acceptDownloads: true,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
    });

    // Zero network, enforced and recorded: any http(s)/ws(s) request from any
    // page, frame, or worker is aborted and fails the test.
    await context.route(/^(https?|wss?):\/\//, route => {
      diagnostics.external.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    context.on('request', request => {
      const url = request.url();
      if (!/^(chrome-extension:|blob:|data:)/.test(url)) diagnostics.external.push(url);
    });
    await context.addInitScript(forceFileInputFallback);
    await context.addInitScript(recordCspEvents);
    for (const page of context.pages()) watch(page, diagnostics);
    context.on('page', page => watch(page, diagnostics));

    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(new URL(worker.url()).host);
  },

  editor: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/editor.html`);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Stapler' });
    await welcome.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await welcome.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Get started' }).click();
      await expect(welcome).toBeHidden();
    }
    await expect(page.locator('header')).toBeVisible();
    await use(page);
  }
});

/**
 * Asserts the page stayed clean: no request out, no CSP violation, no uncaught error.
 *
 * `allowExternal` exempts URLs a test deliberately serves itself — only ever the
 * pinned OCR model (OCR-01), routed to a local copy; everything else still fails.
 */
export async function expectClean(
  page: Page,
  diagnostics: Diagnostics,
  allowExternal: (url: string) => boolean = () => false
) {
  const fromPage = await page
    .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
    .catch(() => [] as string[]);
  expect(
    diagnostics.external.filter(url => !allowExternal(url)),
    'network requests'
  ).toEqual([]);
  expect([...diagnostics.cspViolations, ...fromPage], 'CSP violations').toEqual([]);
  expect(diagnostics.pageErrors, 'page errors').toEqual([]);
}

export { expect };
