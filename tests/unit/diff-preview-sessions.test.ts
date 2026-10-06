/**
 * Regression review R-PDF-3 — the export review's document cache is scoped to
 * the review that loaded it.
 *
 * The cache used to be module-wide and released whenever the review request
 * changed. A queued review replaces the current one directly, and Preact runs
 * the child's new effects (which load the next review's documents) before the
 * parent's cleanup (which released *everything*), so the next review's
 * documents were closed under it and its pages failed to render.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
  id: number;
  dead: boolean;
  released: boolean;
  closed: string[];
  lease: (fn: (api: unknown) => unknown) => Promise<unknown>;
  release: () => void;
}

const clients: FakeClient[] = [];
let nextHandle = 0;

function makeClient(): FakeClient {
  const client: FakeClient = {
    id: clients.length,
    dead: false,
    released: false,
    closed: [],
    lease: async fn => {
      if (client.released) throw new Error('Cannot lease from a released pinned client');
      if (client.dead) throw new Error('The background worker crashed before it could finish.');
      return fn({
        loadDocument: async () => ({ handle: `h${nextHandle++}`, pageCount: 3 }),
        closeDocument: async (handle: string) => {
          client.closed.push(handle);
        },
        renderPage: async () => ({ width: 2, height: 2, close: () => {} })
      });
    },
    release: () => {
      client.released = true;
    }
  };
  clients.push(client);
  return client;
}

// The pixel read-back and diff run in the cv worker (`compare-pages.ts` ›
// `reviewPage`); this fake stands in for it with each side's size.
interface FakeBitmap {
  width: number;
  height: number;
}
const image = (b: FakeBitmap | null) => (b ? new ImageData(b.width || 1, b.height || 1) : null);

vi.mock('../../src/core/workers', () => ({
  renderWorker: { pin: () => makeClient() },
  cvWorker: {
    lease: async (fn: (api: unknown) => unknown) =>
      fn({
        reviewPage: (pair: { a: FakeBitmap | null; b: FakeBitmap | null }) => ({
          before: image(pair.a),
          after: image(pair.b),
          diff: pair.a && pair.b ? image(pair.b) : null,
          comparable: !!(pair.a && pair.b)
        })
      })
  }
}));

const {
  createPreviewSession,
  documentPageCount,
  diffPage,
  releasePreviewDocument,
  releasePreviewDocuments,
  renderPage
} = await import('../../src/core/diff-preview');

beforeEach(() => {
  clients.length = 0;
});

describe('R-PDF-3 — preview sessions', () => {
  it('releasing the previous review does not close the next review’s documents', async () => {
    const shared = new Uint8Array([1]); // same original on both reviews
    const resultA = new Uint8Array([2]);
    const resultB = new Uint8Array([3]);

    const a = createPreviewSession();
    await diffPage(a, shared, resultA, 0, 0);

    // The order Preact produces: the next review's child effect loads first…
    const b = createPreviewSession();
    const pending = diffPage(b, shared, resultB, 0, 0);
    // …then the previous review's cleanup releases its own session.
    await releasePreviewDocuments(a);
    const result = await pending;

    expect(result.before).not.toBeNull();
    expect(result.after).not.toBeNull();
    // Review A's two documents were closed and released; B's are untouched.
    const [aResult, aShared, bResult, bShared] = clients;
    expect(aShared.released && aResult.released).toBe(true);
    expect(bResult.released || bShared.released).toBe(false);
    // B keeps rendering from its own cache.
    expect(await renderPage(b, resultB, 1)).not.toBeNull();
    expect(await documentPageCount(b, resultB)).toBe(3);
    await releasePreviewDocuments(b);
    expect(clients.every(c => c.released)).toBe(true);
  });

  it('a released session refuses new loads instead of leaking them', async () => {
    const s = createPreviewSession();
    await releasePreviewDocuments(s);
    await expect(renderPage(s, new Uint8Array([9]), 0)).rejects.toThrow();
    expect(clients).toHaveLength(0);
  });

  it('reloads a document whose worker died instead of failing every later page', async () => {
    const s = createPreviewSession();
    const bytes = new Uint8Array([4]);
    await renderPage(s, bytes, 0);
    clients[0].dead = true;
    expect(await renderPage(s, bytes, 1)).not.toBeNull();
    expect(clients).toHaveLength(2);
    expect(clients[0].released).toBe(true);
    await releasePreviewDocuments(s);
  });

  it('releases a single document (zip review selection moving off a member)', async () => {
    const s = createPreviewSession();
    const first = new Uint8Array([5]);
    const second = new Uint8Array([6]);
    await renderPage(s, first, 0);
    await releasePreviewDocument(s, first);
    expect(clients[0].released).toBe(true);
    expect(clients[0].closed).toHaveLength(1);
    await renderPage(s, second, 0);
    expect(clients[1].released).toBe(false);
    await releasePreviewDocuments(s);
    expect(clients[1].released).toBe(true);
  });
});
