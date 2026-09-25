/**
 * Regression tests for the 2026-09-25 audit's smaller runtime/UI findings,
 * each against the real module:
 *
 *  • RT-10 / UI-16 — the bitmap cache is budgeted in bytes, never closes a
 *    bitmap still in use, and render scales are clamped to a pixel ceiling.
 *  • RT-15 — a dialog resolving twice no longer skips (and hangs) the next.
 *  • RT-20 — the OPFS-vs-memory decision is probed once, write path included.
 *  • UI-15 — read-aloud cannot keep speaking after Stop or leaving the tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitmapCache, bitmapBytes } from '../../src/core/render-cache';
import {
  clampRenderScale,
  MAX_RENDER_PIXELS,
  MAX_RENDER_SIDE,
  MAX_VIEW_PIXELS
} from '../../src/core/render-limits';
import { viewRenderScale } from '../../src/ui/shell/usePageRender';
import { confirmAction, confirmRequest } from '../../src/core/notify';
import { SpeechSession, type SpeechSynthLike } from '../../src/ui/tools/read-aloud/speech-session';

/** A stand-in ImageBitmap: the cache only reads width/height and calls close(). */
function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
    }
  };
  return bitmap;
}
type FakeBitmap = ReturnType<typeof fakeBitmap>;
const asBitmap = (b: FakeBitmap) => b as unknown as ImageBitmap;

describe('RT-10 — BitmapCache budgets bytes', () => {
  it('evicts least-recently-used entries once over its byte budget', () => {
    // 100×100 RGBA = 40 000 bytes; room for two.
    const cache = new BitmapCache(80_000);
    const a = fakeBitmap(100, 100);
    const b = fakeBitmap(100, 100);
    const c = fakeBitmap(100, 100);
    cache.set('s:0:1.00', asBitmap(a));
    cache.set('s:1:1.00', asBitmap(b));
    expect(cache.bytes).toBe(80_000);
    cache.get('s:0:1.00'); // a is now most recently used
    cache.set('s:2:1.00', asBitmap(c));
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(80_000);
  });

  it('one huge bitmap counts for what it weighs, not as one of 120', () => {
    const cache = new BitmapCache(10_000_000);
    const small = fakeBitmap(200, 200);
    cache.set('s:0:0.50', asBitmap(small));
    // An A4 page at scale 8: ~4760×6736.
    const huge = fakeBitmap(4760, 6736);
    cache.set('s:0:8.00', asBitmap(huge));
    expect(bitmapBytes(huge)).toBeGreaterThan(100_000_000);
    // Over budget with nothing else to drop: the small entry went first.
    expect(small.closed).toBe(true);
  });

  it('never evicts an entry that is in use', () => {
    const cache = new BitmapCache(40_000);
    const shown = fakeBitmap(100, 100);
    cache.set('s:0:1.00', asBitmap(shown));
    cache.retain('s:0:1.00');
    cache.set('s:1:1.00', asBitmap(fakeBitmap(100, 100)));
    expect(shown.closed).toBe(false);
    // Once released, the cache is back over budget and it can go.
    cache.release('s:0:1.00');
    expect(shown.closed).toBe(true);
    expect(cache.bytes).toBe(40_000);
  });

  it('set() on a key whose bitmap is in use keeps it and closes the newcomer', () => {
    const cache = new BitmapCache();
    const drawing = fakeBitmap(10, 10);
    cache.set('s:0:1.00', asBitmap(drawing));
    cache.retain('s:0:1.00');
    const racer = fakeBitmap(10, 10);
    const kept = cache.set('s:0:1.00', asBitmap(racer));
    // Before: the in-use bitmap was closed under its consumer.
    expect(drawing.closed).toBe(false);
    expect(racer.closed).toBe(true);
    expect(kept).toBe(asBitmap(drawing));
    expect(cache.bytes).toBe(400);
  });

  it('set() on a key nobody is drawing replaces and closes the old bitmap', () => {
    const cache = new BitmapCache();
    const old = fakeBitmap(10, 10);
    cache.set('s:0:1.00', asBitmap(old));
    const fresh = fakeBitmap(20, 20);
    expect(cache.set('s:0:1.00', asBitmap(fresh))).toBe(asBitmap(fresh));
    expect(old.closed).toBe(true);
    expect(cache.bytes).toBe(1600);
  });

  it('clear() and invalidateSource() leave in-use bitmaps for release() to close', () => {
    const cache = new BitmapCache();
    const inUse = fakeBitmap(10, 10);
    const idle = fakeBitmap(10, 10);
    cache.set('s:0:1.00', asBitmap(inUse));
    cache.set('s:1:1.00', asBitmap(idle));
    cache.retain('s:0:1.00');
    cache.clear();
    expect(idle.closed).toBe(true);
    expect(inUse.closed).toBe(false);
    expect(cache.get('s:0:1.00')).toBeUndefined();
    cache.release('s:0:1.00');
    expect(inUse.closed).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('RT-10 — render scale ceilings', () => {
  it('leaves an ordinary render alone', () => {
    expect(clampRenderScale(595, 842, 2)).toEqual({ scale: 2, clamped: false });
  });

  it('clamps an A0 page at high zoom under the pixel ceiling, rounding included', () => {
    const { scale, clamped } = clampRenderScale(2384, 3370, 8);
    expect(clamped).toBe(true);
    const w = Math.ceil(2384 * scale);
    const h = Math.ceil(3370 * scale);
    expect(w * h).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_RENDER_SIDE);
    // And not needlessly small.
    expect(w * h).toBeGreaterThan(MAX_RENDER_PIXELS * 0.97);
  });

  it('clamps a very long page by its side, not only its area', () => {
    const { scale, clamped } = clampRenderScale(200, 14_400, 2);
    expect(clamped).toBe(true);
    expect(Math.ceil(14_400 * scale)).toBeLessThanOrEqual(MAX_RENDER_SIDE);
  });

  it('views cap at MAX_VIEW_PIXELS and say so', () => {
    // A4 at 400 % on a 2× display asks for ~32 MP.
    const view = viewRenderScale({ width: 595, height: 842 }, 4, 2);
    expect(view.clamped).toBe(true);
    expect(Math.ceil(595 * view.scale) * Math.ceil(842 * view.scale)).toBeLessThanOrEqual(
      MAX_VIEW_PIXELS
    );
    expect(viewRenderScale({ width: 595, height: 842 }, 1, 2)).toEqual({
      scale: 2,
      clamped: false
    });
  });

  it('ignores degenerate sizes rather than dividing by zero', () => {
    expect(clampRenderScale(0, 842, 2)).toEqual({ scale: 2, clamped: false });
  });
});

describe('RT-15 — modal queue settles each request once', () => {
  afterEach(() => {
    // Drain anything a failing test left queued.
    for (let i = 0; i < 5 && confirmRequest.value; i++) confirmRequest.value.resolve(false);
  });

  it('a double resolve does not skip the next dialog', async () => {
    const first = confirmAction({ title: 'First', body: '' });
    const second = confirmAction({ title: 'Second', body: '' });
    expect(confirmRequest.value?.title).toBe('First');

    const firstRequest = confirmRequest.value!;
    firstRequest.resolve(true);
    // An Escape and a backdrop click in the same frame.
    firstRequest.resolve(false);
    await expect(first).resolves.toBe(true);

    // Before: the second resolve shifted the *second* request off the queue
    // unseen, and its promise never settled.
    expect(confirmRequest.value?.title).toBe('Second');
    confirmRequest.value!.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(confirmRequest.value).toBeNull();
  });

  it('a stale resolve from an already-settled dialog does not close the current one', async () => {
    const first = confirmAction({ title: 'First', body: '' });
    const firstRequest = confirmRequest.value!;
    firstRequest.resolve(false);
    await first;
    const second = confirmAction({ title: 'Second', body: '' });
    firstRequest.resolve(true); // late
    expect(confirmRequest.value?.title).toBe('Second');
    confirmRequest.value!.resolve(false);
    await expect(second).resolves.toBe(false);
  });
});

describe('RT-20 — the storage mode is probed once', () => {
  const nav = navigator as unknown as { storage?: unknown };
  const original = nav.storage;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    nav.storage = original;
  });

  function root(opts: { writable?: boolean } = {}) {
    const files = new Map<string, Uint8Array>();
    return {
      files,
      getFileHandle: async (name: string) => ({
        ...(opts.writable === false
          ? {}
          : {
              createWritable: async () => ({
                write: async (bytes: Uint8Array) => {
                  files.set(name, bytes.slice());
                },
                close: async () => {}
              })
            }),
        getFile: async () => new File([files.get(name) ?? new Uint8Array()], name)
      }),
      removeEntry: async (name: string) => {
        files.delete(name);
      }
    };
  }

  it('a missing createWritable (older Safari) falls back to memory instead of throwing', async () => {
    nav.storage = { getDirectory: async () => root({ writable: false }) };
    const opfs = await import('../../src/core/opfs');
    await expect(opfs.writeSourceBytes('doc', new Uint8Array([1, 2]))).resolves.toBeUndefined();
    expect(await opfs.usesMemoryFallback()).toBe(true);
    expect(await opfs.readSourceBytes('doc')).toEqual(new Uint8Array([1, 2]));
  });

  it('decides once: a later getDirectory failure does not split reads from writes', async () => {
    const r = root();
    let calls = 0;
    nav.storage = {
      getDirectory: async () => {
        calls += 1;
        if (calls > 1) throw new DOMException('denied', 'SecurityError');
        return r;
      }
    };
    const opfs = await import('../../src/core/opfs');
    await opfs.writeSourceBytes('doc', new Uint8Array([7]));
    // Before: this read re-probed, got the SecurityError, and looked in the
    // (empty) memory map for bytes that were in OPFS.
    expect(await opfs.readSourceBytes('doc')).toEqual(new Uint8Array([7]));
    expect(calls).toBe(1);
    // The probe's scratch file is gone.
    expect([...r.files.keys()]).toEqual(['doc.pdf']);
  });
});

describe('UI-15 — read-aloud stops when told to', () => {
  /** Chrome's behaviour: cancel() fires the current utterance's onend. */
  function fakeSynth() {
    let speaking: { onend?: () => void } | null = null;
    const synth: SpeechSynthLike & { spoken: unknown[] } = {
      spoken: [],
      cancel: () => {
        const was = speaking;
        speaking = null;
        was?.onend?.();
      },
      speak: utterance => {
        synth.spoken.push(utterance);
        speaking = utterance as unknown as { onend?: () => void };
      }
    };
    return synth;
  }
  const utterance = () => ({}) as SpeechSynthesisUtterance & { onend?: () => void };

  it('leaving the tool does not auto-advance from the cancelled page', () => {
    const synth = fakeSynth();
    const session = new SpeechSession();
    let status = 'playing';
    let advanced = false;
    const u = utterance();
    u.onend = () => {
      if (session.finished(u) && status === 'playing') advanced = true;
    };
    session.speak(synth, session.begin(), u);

    session.dispose(synth, () => {
      status = 'idle';
    });
    // Before: cancel() ran first, onend saw "playing" and the current
    // utterance, and spoke the next page on a panel no longer on screen.
    expect(advanced).toBe(false);
    expect(status).toBe('idle');
  });

  it('a request superseded (or unmounted) during its text extraction never speaks', () => {
    const synth = fakeSynth();
    const session = new SpeechSession();
    const slow = session.begin(); // awaiting extractPageText…
    session.stop(synth, () => {}); // …the user presses Stop
    expect(session.speak(synth, slow, utterance())).toBe(false);

    const next = session.begin();
    session.dispose(synth, () => {}); // …the user leaves the tool
    expect(session.speak(synth, next, utterance())).toBe(false);
    expect(synth.spoken).toHaveLength(0);
  });

  it('a newer page replaces the old one without the old onend advancing', () => {
    const synth = fakeSynth();
    const session = new SpeechSession();
    const first = utterance();
    let firstFinished = false;
    first.onend = () => {
      firstFinished = session.finished(first);
    };
    session.speak(synth, session.begin(), first);
    const second = utterance();
    session.speak(synth, session.begin(), second);
    expect(firstFinished).toBe(false);
    expect(session.finished(second)).toBe(true);
  });
});
