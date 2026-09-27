/**
 * AUDIT-2026-09-25 M3 — tool state describing one document is reset when the
 * active document, or (where asked) its page list, changes — and *only* then.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import {
  activeDocId,
  addDocument,
  documents,
  makePageRefs,
  registerSource,
  renameDocument,
  rotatePages,
  sources
} from '../../src/core/store';
import { resetOnDocumentChange } from '../../src/ui/tools/docScoped';
import { tableExtractRows } from '../../src/ui/tools/ocr/table-extract-state';
import { extractedText } from '../../src/ui/tools/extract/state';
import { compressReport, compressTargetOutcome } from '../../src/ui/tools/compress/state';
import { activeStamp, signatureSuggestions } from '../../src/ui/tools/sign/state';
import { activeToolId } from '../../src/core/tools';

function seed(id: string) {
  registerSource({
    id: `s-${id}`,
    name: `${id}.pdf`,
    pageCount: 3,
    pageSizes: Array.from({ length: 3 }, () => ({ width: 595, height: 842 }))
  });
  addDocument({
    id,
    name: `${id}.pdf`,
    pages: makePageRefs(`s-${id}`, 3),
    annotations: [],
    dirty: false
  });
}

beforeEach(() => {
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  seed('a');
  seed('b');
  activeDocId.value = 'a';
});

describe('resetOnDocumentChange', () => {
  it('ignores edits that change neither the document nor its pages', () => {
    const value = signal('kept');
    const dispose = resetOnDocumentChange(() => (value.value = 'reset'), { onPageEdits: true });
    value.value = 'kept';
    renameDocument('a', 'renamed.pdf');
    expect(value.value).toBe('kept');
    rotatePages('a', [documents.value[0].pages[0].key], 90);
    expect(value.value).toBe('reset');
    dispose();
  });
});

describe('tool state does not follow the user to another document', () => {
  it('clears table rows, extracted text, compress results and sign state on tab switch', () => {
    tableExtractRows.value = [['A-secret']];
    extractedText.value = 'doc A text';
    compressReport.value = {} as never;
    compressTargetOutcome.value = {} as never;
    signatureSuggestions.value = [{} as never];
    activeStamp.value = { type: 'signature', signatureId: 'x' };

    activeDocId.value = 'b';

    expect(tableExtractRows.value).toBeNull();
    expect(extractedText.value).toBe('');
    expect(compressReport.value).toBeNull();
    expect(compressTargetOutcome.value).toBeNull();
    expect(signatureSuggestions.value).toEqual([]);
    expect(activeStamp.value).toBeNull();
  });

  it('disarms a signature stamp when the tool changes', () => {
    activeStamp.value = { type: 'signature', signatureId: 'x' };
    activeToolId.value = 'outline' as never;
    expect(activeStamp.value).toBeNull();
  });
});
