import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentDocumentBytes, findTextRegions, commit, notify } = vi.hoisted(() => {
  const currentDocumentBytes = vi.fn();
  const findTextRegions = vi.fn();
  const commit = vi.fn();
  const notify = vi.fn();
  return { currentDocumentBytes, findTextRegions, commit, notify };
});

vi.mock('../../src/core/operations', () => ({
  currentDocumentBytes,
  findTextRegions
}));

vi.mock('../../src/core/history', () => ({
  commit
}));

vi.mock('../../src/core/notify', () => ({
  notify
}));

import { searchAndHighlightMatches } from '../../src/ui/tools/annotate/search';
import { activeDocId, documents, sources, type StaplerDoc } from '../../src/core/store';
import { pageAnnotations } from '../../src/ui/tools/annotate/state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ANN-03 search staleness guard', () => {
  const docA: StaplerDoc = {
    id: 'doc-a',
    name: 'a.pdf',
    pages: [{ key: 'a-1', sourceDocId: 'src-a', sourceIndex: 0, rotation: 0 }],
    annotations: [],
    dirty: false
  };
  const docB: StaplerDoc = {
    id: 'doc-b',
    name: 'b.pdf',
    pages: [{ key: 'b-1', sourceDocId: 'src-b', sourceIndex: 0, rotation: 0 }],
    annotations: [],
    dirty: false
  };

  beforeEach(() => {
    documents.value = [docA, docB];
    activeDocId.value = docA.id;
    sources.value = {
      'src-a': {
        id: 'src-a',
        name: 'a.pdf',
        bytes: new Uint8Array([1]),
        pageCount: 1,
        pageSizes: [{ width: 595, height: 842 }]
      },
      'src-b': {
        id: 'src-b',
        name: 'b.pdf',
        bytes: new Uint8Array([2]),
        pageCount: 1,
        pageSizes: [{ width: 595, height: 842 }]
      }
    };
    pageAnnotations.value = {};
    currentDocumentBytes.mockResolvedValue(new Uint8Array([1]));
    findTextRegions.mockReset();
    commit.mockReset();
    notify.mockReset();
  });

  it('drops results when the active document changes mid-search', async () => {
    const gate = deferred<Array<{ pageIndex: number; x: number; y: number; width: number; height: number; text: string }>>();
    findTextRegions.mockReturnValue(gate.promise);

    const run = searchAndHighlightMatches('invoice', false, {} as any);

    activeDocId.value = docB.id;
    gate.resolve([
      { pageIndex: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.05, text: 'invoice' }
    ]);

    const result = await run;

    expect(result).toEqual({ applied: false, matches: 0, unplaced: 0 });
    expect(commit).not.toHaveBeenCalled();
    expect(pageAnnotations.value).toEqual({});
    expect(notify).not.toHaveBeenCalled();
  });
});
