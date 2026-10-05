import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * File System Access pickers for e2e, backed by the browser's real Origin
 * Private File System.
 *
 * Playwright cannot drive the native pickers, so most specs delete them and
 * test the `<input>`/download fallback (`helpers.ts` › `useDownloadFallback`).
 * That leaves the picker-only paths — Batch's folders, folder search, Recents —
 * untested. Here each picker instead returns a *real* `FileSystemHandle` from
 * OPFS: real `values()`, real `createWritable()`, real `NotFoundError` once a
 * file is removed, and structured-cloneable into IndexedDB like a disk handle.
 *
 * This is test-side only: nothing in `src/` knows about it. A test queues what
 * the next picker returns with `queuePick`, the way a person would choose a
 * folder or file in the dialog.
 */

const ROOT = 'e2e-fake-fs';

interface FakeFsWindow {
  __e2ePicks: string[];
  showOpenFilePicker?: unknown;
  showSaveFilePicker?: unknown;
  showDirectoryPicker?: unknown;
}

/** Runs before any app script: installs the three pickers over OPFS. */
function installPickers(options: { saveFilePicker: boolean }) {
  const w = window as unknown as FakeFsWindow;
  w.__e2ePicks = [];
  const root = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-fake-fs', { create: true });
  const resolve = async (path: string, create: boolean) => {
    const parts = path.split('/').filter(Boolean);
    let dir = await root();
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name: parts[parts.length - 1] };
  };
  const nextPick = () => {
    const pick = w.__e2ePicks.shift();
    if (pick === undefined) throw new DOMException('The user aborted a request.', 'AbortError');
    return pick;
  };
  w.showDirectoryPicker = async () => {
    const { dir, name } = await resolve(nextPick(), true);
    return dir.getDirectoryHandle(name, { create: true });
  };
  w.showOpenFilePicker = async () => {
    const { dir, name } = await resolve(nextPick(), false);
    return [await dir.getFileHandle(name)];
  };
  if (options.saveFilePicker) {
    w.showSaveFilePicker = async ({ suggestedName }: { suggestedName?: string } = {}) => {
      const pick = w.__e2ePicks.shift() ?? `saved/${suggestedName ?? 'untitled'}`;
      const { dir, name } = await resolve(pick, true);
      return dir.getFileHandle(name, { create: true });
    };
  } else {
    delete w.showSaveFilePicker;
  }
}

/**
 * Opens the app with OPFS-backed pickers, and clears the first-run dialog.
 *
 * `saveFilePicker: false` leaves the save picker out, so `hasFileSystemAccess()`
 * is false while the directory picker still works — Firefox's and Safari's
 * shape for Batch's ZIP button.
 */
export async function openAppWithFakeFs(
  page: Page,
  options: { saveFilePicker?: boolean; path?: string } = {}
) {
  await page.addInitScript(installPickers, { saveFilePicker: options.saveFilePicker ?? true });
  await page.goto(options.path ?? '/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Stapler' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(page.locator('header')).toBeVisible();
}

/** The path (under the fake root) the next picker returns, in call order. */
export async function queuePick(page: Page, ...paths: string[]) {
  await page.evaluate(picks => {
    (window as unknown as FakeFsWindow).__e2ePicks.push(...picks);
  }, paths);
}

/** Writes files into the fake file system: `{ 'in/a.pdf': bytes }` or a fixture path. */
export async function writeFakeFiles(page: Page, files: Record<string, Uint8Array | string>) {
  const entries = Object.entries(files).map(([name, source]) => [
    name,
    [...(typeof source === 'string' ? readFileSync(path.resolve(source)) : source)]
  ]);
  await page.evaluate(
    async ({ entries, root }) => {
      for (const [filePath, data] of entries as [string, number[]][]) {
        const parts = filePath.split('/');
        let dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle(root, {
          create: true
        });
        for (const part of parts.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(part, { create: true });
        }
        const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();
      }
    },
    { entries, root: ROOT }
  );
}

/** Deletes one file from the fake file system, as moving it away on disk would. */
export async function removeFakeFile(page: Page, filePath: string) {
  await page.evaluate(
    async ({ filePath, root }) => {
      const parts = filePath.split('/');
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(root);
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(parts[parts.length - 1]);
    },
    { filePath, root: ROOT }
  );
}

/** Every file under a fake directory, name → bytes. */
export async function readFakeDir(
  page: Page,
  dirPath: string
): Promise<Record<string, Uint8Array>> {
  const entries = await page.evaluate(
    async ({ dirPath, root }) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(root);
      for (const part of dirPath.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part);
      }
      const out: [string, number[]][] = [];
      const iterable = dir as unknown as {
        values(): AsyncIterable<FileSystemHandle>;
      };
      for await (const entry of iterable.values()) {
        if (entry.kind !== 'file') continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        out.push([entry.name, [...new Uint8Array(await file.arrayBuffer())]]);
      }
      return out;
    },
    { dirPath, root: ROOT }
  );
  return Object.fromEntries(entries.map(([name, data]) => [name, new Uint8Array(data)]));
}
