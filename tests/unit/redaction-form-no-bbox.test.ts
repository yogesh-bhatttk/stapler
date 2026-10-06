/**
 * HRD-36 (AUDIT-EDGE-CASES-2026-09-15 §3 #4) — a Form XObject with no `/BBox`.
 *
 * `/BBox` is required by the spec and omitted by real producers. The redaction
 * filter used to measure such a form as "the unit square" — a 1×1 pt form at
 * the origin — so a mark over its content either missed it entirely (an
 * overlay over intact text) or, the other way round, a form drawn near the
 * origin was deleted wholesale. The contract now: a form with no `/BBox` is
 * judged by its content; refusal happens only when that content cannot be
 * read. The same form must also not hide an image from the image-placement
 * walk that face/logo blur and redaction planning use.
 *
 * Every assertion re-parses the produced bytes: pdf.js text per page, and every
 * decoded stream in the file for the redacted string.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib';

// Real pdf.js / worker work on generated documents: give each test room on a
// busy machine instead of vitest's 5 s default (as other real-worker suites do).
vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl: W } = await import('../../src/core/workers/process.worker');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const job = undefined as never;

async function pageText(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
  await task.destroy();
  return text;
}

async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let all = Buffer.from(bytes).toString('latin1');
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      all += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
    } catch {
      // An image codec cannot hold plain text.
    }
  }
  return all;
}

/** Form XObjects in the file that have no `/BBox`. */
async function formsWithoutBBox(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Form')) continue;
    if (!obj.dict.has(PDFName.of('BBox'))) n++;
  }
  return n;
}

/**
 * A 600 × 800 page whose entire content is one Form XObject without `/BBox`
 * (the "producer wraps the whole page in a form" shape), drawn through a
 * `/Matrix` that moves it off the origin. Optionally the form nests a second
 * form, also without `/BBox`, holding the secret.
 */
async function wholePageForm(
  options: { nested?: boolean; matrix?: number[] } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const fontRes = doc.context.obj({ Font: { F1: font.ref } });

  let outerContent =
    'BT /F1 18 Tf 1 0 0 1 50 300 Tm (FORM KEPT TEXT) Tj ET ' +
    'BT /F1 18 Tf 1 0 0 1 50 700 Tm (SIBLING KEPT) Tj ET ';
  const outerRes: Record<string, Record<string, PDFRef>> = { Font: { F1: font.ref } };
  if (options.nested) {
    const inner = doc.context.flateStream(
      'BT /F1 18 Tf 1 0 0 1 50 650 Tm (NESTED SECRET RUN) Tj ET',
      { Type: 'XObject', Subtype: 'Form', Resources: fontRes }
    );
    outerRes.XObject = { Fx1: doc.context.register(inner) };
    outerContent += 'q /Fx1 Do Q';
  } else {
    outerContent += 'BT /F1 18 Tf 1 0 0 1 50 650 Tm (FORM SECRET RUN) Tj ET';
  }
  const outer = doc.context.flateStream(outerContent, {
    Type: 'XObject',
    Subtype: 'Form',
    // Deliberately no /BBox.
    ...(options.matrix ? { Matrix: options.matrix } : {}),
    Resources: doc.context.obj(outerRes)
  });
  (page.node.Resources() as PDFDict).set(
    PDFName.of('XObject'),
    doc.context.obj({ Fm0: doc.context.register(outer) })
  );
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('q /Fm0 Do Q'))
  );
  return doc.save({ useObjectStreams: false });
}

/** A mark over the band y ∈ [640, 680] of an 800-pt page (top-left normalised). */
const SECRET_BAND = { pageIndex: 0, x: 0.05, y: (800 - 680) / 800, width: 0.6, height: 40 / 800 };

describe('Form XObject with no /BBox (HRD-36 §3 #4)', () => {
  it('a mark over part of a whole-page form with no /BBox filters inside it', async () => {
    const bytes = await wholePageForm();
    expect(await formsWithoutBBox(bytes)).toBe(1);
    expect(await pageText(bytes)).toContain('FORM SECRET RUN');

    const out = await W.applyRedactions(bytes.slice(), [SECRET_BAND], undefined, job);

    const text = await pageText(out);
    expect(text).not.toContain('FORM SECRET RUN');
    expect(text).toContain('FORM KEPT TEXT');
    expect(text).toContain('SIBLING KEPT');
    expect(await everything(out)).not.toContain('FORM SECRET RUN');
    // The rewrite keeps the form's own dictionary: still no invented /BBox.
    expect(await formsWithoutBBox(out)).toBe(1);
  });

  it('honours the form /Matrix when there is no /BBox to measure', async () => {
    // Shifted up by 100: the secret now sits at y = 750, the band at 640–680
    // covers nothing; a mark at 740–780 covers it.
    const bytes = await wholePageForm({ matrix: [1, 0, 0, 1, 0, 100] });
    const miss = await W.applyRedactions(bytes.slice(), [SECRET_BAND], undefined, job);
    expect(await pageText(miss)).toContain('FORM SECRET RUN');

    const hit = await W.applyRedactions(
      bytes.slice(),
      [{ pageIndex: 0, x: 0.05, y: (800 - 780) / 800, width: 0.6, height: 40 / 800 }],
      undefined,
      job
    );
    const text = await pageText(hit);
    expect(text).not.toContain('FORM SECRET RUN');
    expect(text).toContain('FORM KEPT TEXT');
    expect(await everything(hit)).not.toContain('FORM SECRET RUN');
  });

  it('a no-/BBox form nested in a no-/BBox form is filtered recursively', async () => {
    const bytes = await wholePageForm({ nested: true });
    expect(await formsWithoutBBox(bytes)).toBe(2);
    const out = await W.applyRedactions(bytes.slice(), [SECRET_BAND], undefined, job);
    const text = await pageText(out);
    expect(text).not.toContain('NESTED SECRET RUN');
    expect(text).toContain('FORM KEPT TEXT');
    expect(text).toContain('SIBLING KEPT');
    expect(await everything(out)).not.toContain('NESTED SECRET RUN');
  });

  it('a mark that reaches nothing a no-/BBox form draws leaves the form byte-untouched', async () => {
    const bytes = await wholePageForm();
    const source = await PDFDocument.load(bytes);
    const fm0 = (source.getPage(0).node.Resources() as PDFDict)
      .lookup(PDFName.of('XObject'), PDFDict)
      .get(PDFName.of('Fm0')) as PDFRef;
    const original = (source.context.lookup(fm0) as PDFRawStream).contents;

    // A band near the bottom of the page: the form draws nothing there.
    const out = await W.applyRedactions(
      bytes.slice(),
      [{ pageIndex: 0, x: 0.05, y: 0.9, width: 0.5, height: 0.05 }],
      undefined,
      job
    );
    const doc = await PDFDocument.load(out);
    const xobjects = (doc.getPage(0).node.Resources() as PDFDict).lookup(
      PDFName.of('XObject'),
      PDFDict
    );
    expect(xobjects.keys().map(k => k.asString())).toEqual(['/Fm0']);
    const kept = doc.context.lookup(xobjects.get(PDFName.of('Fm0')) as PDFRef) as PDFRawStream;
    expect(Buffer.from(kept.contents).equals(Buffer.from(original))).toBe(true);
    const text = await pageText(out);
    expect(text).toContain('FORM SECRET RUN');
    expect(text).toContain('FORM KEPT TEXT');
  });

  it('refuses, and changes nothing, when a no-/BBox form’s content cannot be read', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    // Claims Flate, holds garbage: the content is unreadable, and with no
    // /BBox there is no extent to fall back on.
    const broken = doc.context.stream(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      Type: 'XObject',
      Subtype: 'Form',
      Filter: 'FlateDecode'
    });
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Fm0: doc.context.register(broken) })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q /Fm0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });

    await expect(W.applyRedactions(bytes.slice(), [SECRET_BAND], undefined, job)).rejects.toThrow(
      /declares no \/BBox/
    );
    // The planning pass the pipeline runs first refuses the same way, so the
    // caller never gets as far as writing anything.
    await expect(W.planImageRedactions(bytes.slice(), [SECRET_BAND])).rejects.toThrow(
      /declares no \/BBox/
    );
  });

  it('an image inside a no-/BBox form is placed (face/logo blur, redaction planning)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const image = doc.context.stream(new Uint8Array(3 * 4), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8
    });
    const imageRef = doc.context.register(image);
    const form = doc.context.flateStream('q 200 0 0 100 50 600 cm /Im0 Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      Matrix: [1, 0, 0, 1, 10, 20],
      Resources: doc.context.obj({ XObject: { Im0: imageRef } })
    });
    (page.node.Resources() as PDFDict).set(
      PDFName.of('XObject'),
      doc.context.obj({ Fm0: doc.context.register(form) })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q /Fm0 Do Q'))
    );
    const bytes = await doc.save({ useObjectStreams: false });

    // Face/logo blur's planning reaches the image through the form.
    const plan = await W.planPageImages(bytes.slice(), [0]);
    expect(plan.images).toEqual([
      { pageIndex: 0, name: 'Im0', objectNumber: imageRef.objectNumber, inForm: true }
    ]);

    // And the geometry walk places it at its real size.
    const { placements } = await W.imagePlacements(bytes.slice(), [0], job);
    expect(placements).toHaveLength(1);
    // Not clipped to a phantom unit square: the full 200 × 100 placement,
    // moved by the form's /Matrix.
    expect(placements[0]).toMatchObject({
      pageIndex: 0,
      objectNumber: imageRef.objectNumber,
      x: 60,
      y: 620,
      width: 200,
      height: 100
    });
  });
});
