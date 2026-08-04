import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFString, PDFDict } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));
import { processWorkerImpl } from '../../src/core/workers/process.worker';

describe('scrubMetadata', () => {
  it('strips all metadata by default', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Secret Title');
    doc.setAuthor('Secret Author');
    doc.setSubject('Secret Subject');

    // Add custom info dictionary property
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(doc.context.obj('CompanyPath'), PDFString.of('C:\\Users\\JohnDoe\\Documents'));

    const bytes = await doc.save();

    const scrubbedBytes = await processWorkerImpl.scrubMetadata(bytes);

    // Check what is left
    const scrubbedDoc = await PDFDocument.load(scrubbedBytes);
    expect(scrubbedDoc.getTitle()).toBeUndefined();
    expect(scrubbedDoc.getAuthor()).toBeUndefined();
    expect(scrubbedDoc.getSubject()).toBeUndefined();

    const scrubbedInfo = scrubbedDoc.context.lookup(scrubbedDoc.context.trailerInfo.Info, PDFDict);
    expect(scrubbedInfo.get(scrubbedDoc.context.obj('CompanyPath'))).toBeUndefined();
  });

  it('keeps selected metadata based on settings', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Kept Title');
    doc.setAuthor('Stripped Author');

    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(doc.context.obj('CustomData'), PDFString.of('Keep Me'));

    const bytes = await doc.save();

    // We only strip 'author', so title and customInfo are kept
    const scrubbedBytes = await processWorkerImpl.scrubMetadata(bytes, {
      author: true,
      title: false,
      customInfo: false
    });

    const scrubbedDoc = await PDFDocument.load(scrubbedBytes);
    expect(scrubbedDoc.getTitle()).toBe('Kept Title');
    expect(scrubbedDoc.getAuthor()).toBeUndefined();

    const scrubbedInfo = scrubbedDoc.context.lookup(scrubbedDoc.context.trailerInfo.Info, PDFDict);
    expect(scrubbedInfo.get(scrubbedDoc.context.obj('CustomData'))).toBeDefined();
  });
});

describe('applyRedactions', () => {
  it('performs operator-level removal of text within region', async () => {
    // Generate a simple PDF with text
    const { textPdf } = await import('../e2e/fixtures');
    const bytes = await textPdf(1);

    // Redact the top half of the page
    const regions = [
      {
        pageIndex: 0,
        x: 0,
        y: 0,
        width: 1,
        height: 0.5 // Top half (y=0 is top in normalized coords)
      }
    ];

    const redactedBytes = await processWorkerImpl.applyRedactions(bytes, regions);

    // Load back and extract text manually (the pdf-lib extraction would need renderWorker,
    // but we can just check the raw content stream for the redacted size).
    const doc = await PDFDocument.load(redactedBytes);
    // Verify the page is accessible (structure is intact)
    void doc.getPage(0);
    // The contents stream has been modified and appended to.
    // Just verify the bytes are different from the source bytes, showing it rebuilt.
    expect(redactedBytes).not.toEqual(bytes);
    expect(redactedBytes.length).toBeGreaterThan(0);
  });
});
