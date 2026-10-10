/**
 * GAP-12 — "Clear all local data" really clears it, end to end, in the built
 * web twin: store a session (an imported document, autosaved to IndexedDB with
 * its bytes in OPFS) and a saved signature, clear everything from the trust
 * panel, and after the reload nothing is offered back and no signature is left.
 *
 * GAP-9 — the trust panel reports storage usage and persistence.
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoTool, importFile, openApp } from './helpers';

const FIXTURE = 'tests/fixtures/merge-source-1.pdf';

/** What Stapler has in IndexedDB and OPFS right now, read from inside the page. */
async function storedState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('stapler');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(store: string, op: (s: IDBObjectStore) => IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        const request = op(db.transaction(store, 'readonly').objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const session = (await read('settings', s => s.get('session.recovery'))) as {
      documents?: unknown[];
    } | null;
    const signatures = await read('signatures', s => s.count());
    db.close();
    const root = await navigator.storage.getDirectory();
    const pdfs: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.endsWith('.pdf')) pdfs.push(name);
    }
    return { sessionDocs: session?.documents?.length ?? 0, signatures, pdfs };
  });
}

test.describe('GAP-12 — clear all local data', () => {
  test('a stored session and signature are gone after Clear all + reload', async ({ page }) => {
    await openApp(page);
    await importFile(page, FIXTURE);

    // A typed signature, saved to the library.
    await gotoTool(page, 'sign');
    await page.getByRole('button', { name: 'Create a signature' }).click();
    const modal = page.getByRole('dialog', { name: 'Create a signature' });
    await modal.getByRole('tab', { name: 'Type' }).click();
    await modal.getByRole('textbox', { name: 'Signature text' }).fill('Ada Lovelace');
    await modal.getByRole('button', { name: 'Save signature' }).click();
    await expect(page.getByRole('button', { name: 'Use this typed signature' })).toBeVisible();

    // Autosave is debounced; wait until the session record and bytes are really stored.
    await expect
      .poll(async () => storedState(page), { timeout: 10_000 })
      .toMatchObject({ sessionDocs: 1, signatures: 1 });
    expect((await storedState(page)).pdfs.length).toBeGreaterThan(0);

    // The trust panel lists it.
    await page.getByRole('button', { name: /Read how to verify this/ }).click();
    const trust = page.getByRole('dialog', { name: 'Zero network. Zero tracking.' });
    const stored = trust.getByRole('list', { name: 'Stored on this device' });
    await expect(stored).toBeVisible();
    await expect(
      stored.getByRole('listitem').filter({ hasText: 'Saved signatures' })
    ).toContainText('1 saved');
    await expect(
      stored.getByRole('listitem').filter({ hasText: 'Open and recoverable documents' })
    ).toContainText(/1 file/);
    await expect(trust).toContainText(/available to this site is in use|does not report/);

    // Clear everything; the confirmation says the open document will be closed.
    await trust.getByRole('button', { name: 'Clear all local data…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Clear all local data?' });
    await expect(confirm).toContainText('The open document will be closed');
    await expect(confirm).toContainText('1 saved signature');
    const reloaded = page.waitForEvent('load');
    await confirm.getByRole('button', { name: 'Clear all local data', exact: true }).click();
    await reloaded;

    // A fresh start: the first-run welcome is back (settings were cleared) and
    // no restore prompt is offered.
    const welcome = page.getByRole('dialog', { name: 'Welcome to Stapler' });
    await expect(welcome).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(page.getByRole('dialog', { name: 'Restore your previous session?' })).toHaveCount(
      0
    );
    expect(await storedState(page)).toEqual({ sessionDocs: 0, signatures: 0, pdfs: [] });

    // A second reload still restores nothing (nothing wrote the record back).
    // Audit 2026-10-10 T10: was a fixed 1 s sleep before checking for the
    // prompt. An import is refused while the startup recovery check is still
    // pending or its prompt is up (`waitForImportReadiness`), so the import
    // succeeding is the positive signal that the check has finished — and
    // decided there was nothing to offer.
    await page.goto('/');
    await expect(page.locator('header')).toBeVisible();
    await importFile(page, FIXTURE);
    await expect(page.getByRole('dialog', { name: 'Restore your previous session?' })).toHaveCount(
      0
    );
    await expect(page.getByText('Answer the restore prompt first.')).toHaveCount(0);

    // The Sign panel (it needs a document open) shows an empty library.
    await gotoTool(page, 'sign');
    await expect(page.getByRole('button', { name: 'Create a signature' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use this typed signature' })).toHaveCount(0);
  });

  test('cancelling the confirmation keeps everything', async ({ page }) => {
    await openApp(page);
    await importFile(page, FIXTURE);
    await expect.poll(async () => (await storedState(page)).sessionDocs).toBe(1);
    await page.getByRole('button', { name: /Read how to verify this/ }).click();
    const trust = page.getByRole('dialog', { name: 'Zero network. Zero tracking.' });
    await trust.getByRole('button', { name: 'Clear all local data…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Clear all local data?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    // Escape answered only the top dialog; the trust panel is still open.
    await expect(trust).toBeVisible();
    expect((await storedState(page)).sessionDocs).toBe(1);
  });
});
