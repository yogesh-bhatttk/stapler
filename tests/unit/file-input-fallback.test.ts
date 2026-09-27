import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_CANCEL_FALLBACK_MS, openFilesViaInput } from '../../src/platform/file-system';

/**
 * Audit 2026-09-25 PLT-19 — the `<input type=file>` fallback treated "window
 * regained focus and no `change` within 300 ms" as a cancel, everywhere. A slow
 * selection whose `change` event arrived later was silently dropped.
 *
 * vitest runs in `node`, so this stands up the handful of DOM pieces the
 * function touches: a `document` that makes one fake input, a `window` event
 * target, and (optionally) an `HTMLInputElement` whose prototype does or does
 * not have `oncancel`.
 */

class FakeInput extends EventTarget {
  type = '';
  multiple = false;
  accept = '';
  files: FileList | null = null;
  style: Record<string, string> = {};
  clicked = false;
  removed = false;
  click() {
    this.clicked = true;
  }
  remove() {
    this.removed = true;
  }
}

function fileList(...names: string[]): FileList {
  const files = names.map(name => new File([new Uint8Array([1])], name));
  return Object.assign(files, { item: (i: number) => files[i] ?? null }) as unknown as FileList;
}

let input: FakeInput;
let win: EventTarget;
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

function installDom(cancelSupported: boolean) {
  input = new FakeInput();
  win = new EventTarget();
  for (const key of ['document', 'window', 'HTMLInputElement']) saved[key] = g[key];
  g.document = {
    createElement: () => input,
    body: { append: () => {} }
  };
  g.window = win;
  class FakeHTMLInputElement {}
  if (cancelSupported) {
    (FakeHTMLInputElement.prototype as unknown as { oncancel: null }).oncancel = null;
  }
  g.HTMLInputElement = FakeHTMLInputElement;
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
  vi.useRealTimers();
});

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('openFilesViaInput where the cancel event exists', () => {
  beforeEach(() => installDom(true));

  it('resolves with the chosen files on change', async () => {
    const result = openFilesViaInput({ multiple: true });
    expect(input.clicked).toBe(true);
    input.files = fileList('a.pdf', 'b.png');
    input.dispatchEvent(new Event('change'));
    const files = await result;
    expect(files.map(f => f.name)).toEqual(['a.pdf', 'b.png']);
    expect(input.removed).toBe(true);
  });

  it('resolves empty on cancel', async () => {
    const result = openFilesViaInput();
    input.dispatchEvent(new Event('cancel'));
    expect(await result).toEqual([]);
  });

  it('does not treat a returning focus as a cancel: a slow change still lands', async () => {
    vi.useFakeTimers();
    const result = openFilesViaInput();
    win.dispatchEvent(new Event('focus'));
    // Far past the old 300 ms heuristic, and past the fallback too.
    vi.advanceTimersByTime(FOCUS_CANCEL_FALLBACK_MS * 3);
    expect(await isSettled(result)).toBe(false);
    input.files = fileList('slow.pdf');
    input.dispatchEvent(new Event('change'));
    expect((await result).map(f => f.name)).toEqual(['slow.pdf']);
  });

  it('re-checks input.files on cancel instead of discarding a landed selection', async () => {
    const result = openFilesViaInput();
    input.files = fileList('landed.pdf');
    input.dispatchEvent(new Event('cancel'));
    expect((await result).map(f => f.name)).toEqual(['landed.pdf']);
  });
});

describe('openFilesViaInput where the cancel event does not exist', () => {
  beforeEach(() => installDom(false));

  it('waits well past 300 ms after focus returns before giving up', async () => {
    vi.useFakeTimers();
    const result = openFilesViaInput();
    win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);
    expect(await isSettled(result)).toBe(false);
    input.files = fileList('late.pdf');
    input.dispatchEvent(new Event('change'));
    expect((await result).map(f => f.name)).toEqual(['late.pdf']);
  });

  it('eventually settles as a cancel so the calling job never hangs', async () => {
    vi.useFakeTimers();
    const result = openFilesViaInput();
    win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(FOCUS_CANCEL_FALLBACK_MS);
    expect(await result).toEqual([]);
  });

  it('picks up files already on the input when the fallback fires', async () => {
    vi.useFakeTimers();
    const result = openFilesViaInput();
    win.dispatchEvent(new Event('focus'));
    input.files = fileList('quiet.pdf');
    vi.advanceTimersByTime(FOCUS_CANCEL_FALLBACK_MS);
    expect((await result).map(f => f.name)).toEqual(['quiet.pdf']);
  });
});
