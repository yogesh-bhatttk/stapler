/**
 * AUDIT-2026-09-25 UI-1 — "Strip & export" without a prior "Inspect" must strip
 * everything, and an inspection must not carry over to another document.
 *
 * `scrubSettings` used to start as `{}`. The worker's strip-everything default is
 * `settings || {…}`, and `{}` is truthy, so nothing at all was removed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';
import {
  activeDocId,
  addDocument,
  documents,
  makePageRefs,
  registerSource,
  sources,
  type StaplerDoc
} from '../../src/core/store';
import { metadataFindings, scrubSettings } from '../../src/ui/tools/metadata/state';
import type { MetadataFindings } from '../../src/core/workers/process.worker';

function seedDoc(id: string): StaplerDoc {
  registerSource({
    id: `src-${id}`,
    name: `${id}.pdf`,
    pageCount: 1,
    pageSizes: [{ width: 595, height: 842 }]
  });
  const pages = makePageRefs(`src-${id}`, 1);
  const doc: StaplerDoc = {
    id,
    name: `${id}.pdf`,
    pages,
    baseline: pages,
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  return doc;
}

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
});

describe('metadata scrub default (UI-1)', () => {
  it('starts uninspected, and the uninspected value strips Author and Title', async () => {
    expect(scrubSettings.value).toBeNull();

    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.setAuthor('Jane Secret');
    pdf.setTitle('Internal title');
    const bytes = await pdf.save();

    // Exactly what commit.ts passes.
    const out = await processWorkerImpl.scrubMetadata(bytes, scrubSettings.value ?? undefined);
    const scrubbed = await PDFDocument.load(out);
    expect(scrubbed.getAuthor()).toBeUndefined();
    expect(scrubbed.getTitle()).toBeUndefined();
    expect(new TextDecoder('latin1').decode(out)).not.toContain('Jane Secret');
  });

  it('forgets an inspection when the active document changes', () => {
    seedDoc('a');
    seedDoc('b');
    activeDocId.value = 'a';
    metadataFindings.value = { author: 'A' } as unknown as MetadataFindings;
    scrubSettings.value = { author: true };

    activeDocId.value = 'b';
    expect(scrubSettings.value).toBeNull();
    expect(metadataFindings.value).toBeNull();
  });
});
