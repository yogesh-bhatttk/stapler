/**
 * RED-09 — the mocked test in `batch-runner.test.ts` proves `runBatch` routes each
 * file's own bytes into its own `readMetadata`/`scrubMetadata` call; because both
 * calls are stubs there, it never proves metadata is actually removed from real
 * output. This drives the real worker implementation on two real documents with
 * different metadata, the way `golden.test.ts` proves other operations against
 * real re-parsed bytes rather than mocked ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';
import {
  stripAllMetadataSettings,
  hasAnyMetadataFinding,
  countMetadataFindings
} from '../../src/core/metadata-scrub';

describe('RED-09: batch metadata scrub against the real worker', () => {
  it('builds independent strip settings per document and actually removes them from real output', async () => {
    const a = await PDFDocument.create();
    a.addPage([200, 200]);
    a.setTitle('Board pack');
    a.setAuthor('Grace Hopper');
    const bytesA = await a.save();

    const b = await PDFDocument.create();
    b.addPage([200, 200]);
    b.setSubject('Finance');
    b.setKeywords(['quarterly', 'report']);
    const bytesB = await b.save();

    const findingsA = await processWorkerImpl.readMetadata(bytesA);
    const findingsB = await processWorkerImpl.readMetadata(bytesB);
    const settingsA = stripAllMetadataSettings(findingsA);
    const settingsB = stripAllMetadataSettings(findingsB);

    // Each document's strip settings come from its own findings only — proof
    // there's no shared/leaked state between the two independent decisions.
    expect(settingsA.title).toBe(true);
    expect(settingsA.author).toBe(true);
    expect(settingsA.subject).toBeUndefined();
    expect(settingsA.keywords).toBeUndefined();
    expect(settingsB.subject).toBe(true);
    expect(settingsB.keywords).toBe(true);
    expect(settingsB.title).toBeUndefined();
    expect(settingsB.author).toBeUndefined();

    expect(hasAnyMetadataFinding(settingsA)).toBe(true);
    expect(hasAnyMetadataFinding(settingsB)).toBe(true);
    expect(countMetadataFindings(findingsA)).toBeGreaterThanOrEqual(2);
    expect(countMetadataFindings(findingsB)).toBeGreaterThanOrEqual(2);

    const scrubbedA = await processWorkerImpl.scrubMetadata(bytesA, settingsA, silentJob);
    const scrubbedB = await processWorkerImpl.scrubMetadata(bytesB, settingsB, silentJob);

    const rereadA = await processWorkerImpl.readMetadata(scrubbedA);
    const rereadB = await processWorkerImpl.readMetadata(scrubbedB);
    expect(rereadA.title).toBeUndefined();
    expect(rereadA.author).toBeUndefined();
    expect(rereadB.subject).toBeUndefined();
    expect(rereadB.keywords).toBeUndefined();

    // And the parsed document itself, not just the findings report, is clean.
    const outA = await PDFDocument.load(scrubbedA);
    expect(outA.getTitle()).toBeUndefined();
    expect(outA.getAuthor()).toBeUndefined();
    const outB = await PDFDocument.load(scrubbedB);
    expect(outB.getSubject()).toBeUndefined();
    expect(outB.getKeywords()).toBeUndefined();
  });

  it("catches pdf-lib's own stamped producer/creator/dates on an otherwise plain document", async () => {
    // No title/author/subject set — but pdf-lib stamps Producer, Creator, and both
    // dates on every `.save()` unless told not to, and that identifying string is
    // exactly the kind of disclosure RED-04 exists to catch. A batch scrub that
    // only looked for user-set fields would leave it behind on every single file.
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();

    const findings = await processWorkerImpl.readMetadata(bytes);
    expect(findings.producer).toContain('pdf-lib');
    expect(findings.creator).toContain('pdf-lib');
    expect(findings.creationDate).toBeDefined();
    expect(findings.modificationDate).toBeDefined();
    expect(findings.title).toBeUndefined();
    expect(findings.author).toBeUndefined();

    const settings = stripAllMetadataSettings(findings);
    expect(settings).toEqual({
      producer: true,
      creator: true,
      creationDate: true,
      modificationDate: true
    });
    expect(hasAnyMetadataFinding(settings)).toBe(true);
    expect(countMetadataFindings(findings)).toBe(4);

    const scrubbed = await processWorkerImpl.scrubMetadata(bytes, settings, silentJob);
    const reread = await processWorkerImpl.readMetadata(scrubbed);
    expect(reread.producer).toBeUndefined();
    expect(reread.creator).toBeUndefined();
    expect(reread.creationDate).toBeUndefined();
    expect(reread.modificationDate).toBeUndefined();
  });
});
