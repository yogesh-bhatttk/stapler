/**
 * Optional content (layers) through a redaction save — AUDIT §3, first bullet.
 *
 * `applyRedactions` rebuilds the document into a fresh one and carries only a
 * short list of catalog entries across. `/OCProperties` was not on it, which
 * looks like the safe direction — dropping is how everything else that can leak
 * redacted content is handled — but it is the one case where dropping *adds*
 * content: the `/OC` marked-content operators and the `/Properties` resources
 * naming the groups stay in the page, and with no configuration left to say a
 * group is off, a viewer draws and prints it. A redaction pass that is only
 * supposed to remove things would start revealing a layer the author had hidden.
 *
 * Carrying it across is not just "add the key to the list", which is why the
 * first assertion here is about object *identity*: `copyPages` builds a fresh
 * object copier per call, so a catalog-level copy of a group and page 1's copy
 * and page 2's copy are three different objects. A configuration that lists
 * groups no page draws with, while every group the pages do draw with is absent
 * from it, un-hides the layer exactly as reliably as having no configuration.
 *
 * Everything is asserted against the re-parsed output bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

const HIDDEN = 'HIDDEN-LAYER-SECRET';
const MARKED = 'MARK THIS LINE';

/**
 * `pageCount` pages that each draw a visible line, a hidden-layer line, and a
 * line the caller's mark will cover — all three naming the *same* optional
 * content group, which is switched off in the default configuration.
 */
async function layeredDocument(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: 'Internal notes' }));

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 300]);
    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({
        Font: doc.context.obj({ F1: font.ref }),
        Properties: doc.context.obj({ MC0: ocg })
      })
    );
    const content =
      'BT /F1 12 Tf 20 260 Td (visible top) Tj ET\n' +
      `/OC /MC0 BDC BT /F1 12 Tf 20 150 Td (${HIDDEN}) Tj ET EMC\n` +
      `BT /F1 12 Tf 20 40 Td (${MARKED}) Tj ET\n`;
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream(new TextEncoder().encode(content)))
    );
  }

  doc.catalog.set(
    PDFName.of('OCProperties'),
    doc.context.obj({
      OCGs: [ocg],
      D: doc.context.obj({ BaseState: 'ON', OFF: [ocg], Order: [ocg] })
    })
  );
  return doc.save({ useObjectStreams: false });
}

/** The group reference a page's `/Properties /MC0` resolves to. */
function groupNamedByPage(doc: PDFDocument, pageIndex: number): PDFRef {
  const properties = doc
    .getPage(pageIndex)
    .node.Resources()
    ?.lookupMaybe(PDFName.of('Properties'), PDFDict);
  const ref = properties?.get(PDFName.of('MC0'));
  if (!(ref instanceof PDFRef)) throw new Error('page does not name an optional content group');
  return ref;
}

function configuration(doc: PDFDocument): { ocgs: PDFRef[]; off: PDFRef[] } {
  const props = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!props) throw new Error('no /OCProperties in the output catalog');
  const refs = (value: unknown): PDFRef[] => {
    const array = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (!(array instanceof PDFArray)) return [];
    return array.asArray().filter((entry): entry is PDFRef => entry instanceof PDFRef);
  };
  const d = props.lookupMaybe(PDFName.of('D'), PDFDict);
  return { ocgs: refs(props.get(PDFName.of('OCGs'))), off: refs(d?.get(PDFName.of('OFF'))) };
}

/** A mark over the bottom line, nowhere near the hidden one. */
const BOTTOM_MARK = { pageIndex: 0, x: 0.0, y: 0.8, width: 0.9, height: 0.15 };

describe('redaction keeps a hidden layer hidden (§3)', () => {
  it('carries /OCProperties across, pointing at the groups the pages actually name', async () => {
    const out = await processWorkerImpl.applyRedactions(await layeredDocument(), [BOTTOM_MARK]);
    const doc = await PDFDocument.load(out);

    const named = groupNamedByPage(doc, 0);
    const { ocgs, off } = configuration(doc);

    // Identity, not "there is an /OCGs array with something in it": the group
    // the content stream draws with has to be the same object the
    // configuration switches off.
    expect(ocgs.map(String)).toContain(String(named));
    expect(off.map(String)).toContain(String(named));
  });

  it('leaves the hidden content hidden rather than either revealing or losing it', async () => {
    const out = await processWorkerImpl.applyRedactions(await layeredDocument(), [BOTTOM_MARK]);
    const content = await pageContent(out, 0);

    // Still in the file, still inside its /OC block…
    expect(content).toContain(HIDDEN);
    expect(content).toContain('/OC /MC0 BDC');
    // …and still switched off, which is the half that makes the line above
    // "hidden" rather than "revealed".
    const doc = await PDFDocument.load(out);
    expect(configuration(doc).off.map(String)).toContain(String(groupNamedByPage(doc, 0)));
    // And the mark did its job.
    expect(content).not.toContain(MARKED);
  });

  it('gives two pages that share one group the same object, not one copy each', async () => {
    // The failure this pins down: per-page copiers make page 1's group and
    // page 2's group different objects, so a configuration can name at most
    // one of them and the other page's layer comes back visible.
    const out = await processWorkerImpl.applyRedactions(await layeredDocument(2), [BOTTOM_MARK]);
    const doc = await PDFDocument.load(out);

    const first = groupNamedByPage(doc, 0);
    const second = groupNamedByPage(doc, 1);
    expect(String(second)).toBe(String(first));

    const { ocgs, off } = configuration(doc);
    expect(ocgs.map(String)).toContain(String(first));
    expect(off.map(String)).toContain(String(first));
  });

  it('relinks an /OC on an XObject, not just one in /Properties', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);
    const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: 'Stamp' }));

    const form = doc.context.flateStream(
      new TextEncoder().encode(`BT /F1 12 Tf 20 150 Td (${HIDDEN}) Tj ET`),
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 120, 300, 180],
        Resources: doc.context.obj({ Font: { F1: font.ref } })
      }
    );
    form.dict.set(PDFName.of('OC'), ocg);
    const formRef = doc.context.register(form);

    page.node.set(
      PDFName.of('Resources'),
      doc.context.obj({
        Font: doc.context.obj({ F1: font.ref }),
        XObject: doc.context.obj({ Fm0: formRef })
      })
    );
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          new TextEncoder().encode(`q /Fm0 Do Q BT /F1 12 Tf 20 40 Td (${MARKED}) Tj ET`)
        )
      )
    );
    doc.catalog.set(
      PDFName.of('OCProperties'),
      doc.context.obj({ OCGs: [ocg], D: doc.context.obj({ BaseState: 'ON', OFF: [ocg] }) })
    );

    const out = await processWorkerImpl.applyRedactions(await doc.save(), [BOTTOM_MARK]);
    const rebuilt = await PDFDocument.load(out);

    const xObjects = rebuilt
      .getPage(0)
      .node.Resources()
      ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const formEntry = xObjects?.get(PDFName.of('Fm0'));
    const formStream = formEntry instanceof PDFRef ? rebuilt.context.lookup(formEntry) : formEntry;
    const oc = (formStream as { dict: PDFDict }).dict.get(PDFName.of('OC'));
    expect(oc).toBeInstanceOf(PDFRef);

    const { ocgs, off } = configuration(rebuilt);
    expect(ocgs.map(String)).toContain(String(oc));
    expect(off.map(String)).toContain(String(oc));
  });

  it('adds no /OCProperties to a document that never had one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]).drawText('plain');
    const out = await processWorkerImpl.applyRedactions(await doc.save(), [BOTTOM_MARK]);
    const rebuilt = await PDFDocument.load(out);
    expect(rebuilt.catalog.get(PDFName.of('OCProperties'))).toBeUndefined();
  });
});

/** One page's content streams, decompressed, as latin1 text. */
async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(pageIndex).node.Contents();
  if (!contents) return '';
  // `any`: pdf-lib exposes no common interface for "a stream I can read bytes
  // from" across PDFRawStream and PDFContentStream.
  const streams: any[] =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let out = '';
  for (const stream of streams) {
    const raw: Uint8Array = stream.getContents();
    const flate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    out += new TextDecoder('latin1').decode(flate ? await decodeStream(raw) : raw);
  }
  return out;
}
