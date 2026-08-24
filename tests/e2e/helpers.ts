import { expect, type Page } from '@playwright/test';

/**
 * Forces the `<input type=file>` + anchor-download fallback.
 *
 * `localhost` is a secure context, so the File System Access pickers are available and
 * the adapter prefers them — but they are native OS dialogs that Playwright cannot drive,
 * so a save produces no `download` event and nothing can be asserted about the bytes.
 *
 * The consequence is worth stating: **these tests exercise the fallback path**, which is
 * what Firefox and Safari use (DIST-04). The picker path — and with it save-over-original
 * and Recents — is not covered here and needs a manual pass (QA-05).
 */
export async function useDownloadFallback(page: Page) {
  await page.addInitScript(() => {
    // Deleted before any app script runs, so `supportsFileSystemAccess` is false at
    // module-evaluation time.
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });
}

/**
 * Opens the app and clears the first-run dialog.
 *
 * Every test gets a fresh browser context, so the welcome dialog always appears — and its
 * scrim swallows clicks, which is the focus trap doing its job. It is shown only after the
 * first-run flag has been read back from IndexedDB, so this waits for it rather than
 * sampling `isVisible()` and racing that read.
 */
export async function openApp(page: Page) {
  await useDownloadFallback(page);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Stapler' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
    // Already dismissed in this context — nothing to do.
  });
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(dialog).toBeHidden();
  }
  // DOC-11 — a leftover autosave record from a prior session in the same storage
  // state surfaces this prompt too; its scrim swallows clicks just like the welcome
  // dialog's, so a test that reloads and then interacts with the page hangs on it.
  // "Start fresh" is the right default for a test fixture: it should never inherit
  // undo history or open documents from a session it didn't create.
  const recovery = page.getByRole('dialog', { name: 'Restore your previous session?' });
  if (await recovery.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await expect(recovery).toBeHidden();
  }
  await expect(page.locator('header')).toBeVisible();
}

/**
 * Switches tool by hash, the way the rail does.
 *
 * `page.goto` reloads the tab, and an open document lives in memory only (see the note on
 * session persistence in src/core/store.ts), so a reload legitimately empties the
 * workspace.
 */
export async function gotoTool(page: Page, tool: string) {
  await page.evaluate(id => {
    window.location.hash = `#/tool/${id}`;
  }, tool);
}

/** Imports a file through the real file input and waits for the grid. */
export async function importFile(page: Page, file: string) {
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}
