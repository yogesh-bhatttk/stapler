/**
 * RED-03 — the "is the string anywhere else in the output?" half of the gate.
 *
 * `applyRedactions` proves a region is geometrically and visually clear, and
 * then asks `collectOffPageText` for every piece of text a viewer never paints
 * on a page — because a copy of the redacted string quoted somewhere the page
 * text does not reach would otherwise sail through. If the string comes back,
 * `verifyRedaction` fails the region and the save is blocked.
 *
 * The collector only looked at annotation `/Contents` and at text field,
 * dropdown and option-list values, so the string was invisible to it — and
 * therefore "verified absent" — when it lived in:
 *
 *   • a link's `/A /URI`
 *   • a markup annotation's `/RC` with no `/Contents` (string *or* stream)
 *   • a field's `/TU` tooltip
 *   • a field's `/DV` default value
 *   • a check box's or radio group's `/V` / `/AS` name state
 *   • a `FileAttachment`'s `/FS /EF` embedded file (its bytes or its name)
 *
 * Every case below is built with pdf-lib, saved to real bytes, and read back
 * through the worker's own entry point.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFString } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

const SECRET = 'Wilhelmina-Dagoberto-91442';

/** A one-page document carrying whatever `build` hangs off it. */
async function docWith(
  build: (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => void
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  build(doc, page);
  return doc.save({ useObjectStreams: false });
}

function annotate(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>, annot: PDFDict) {
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
}

/** Everything the verifier would search, as one lower-cased haystack. */
async function haystack(bytes: Uint8Array): Promise<string> {
  const found = await processWorkerImpl.collectOffPageText(bytes);
  return found.join('\n').toLowerCase();
}

describe('collectOffPageText sees text a viewer never paints (§1.4)', () => {
  it('finds a link action URI', async () => {
    const bytes = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 30],
          A: doc.context.obj({
            Type: 'Action',
            S: 'URI',
            URI: PDFString.of(`https://example.invalid/${SECRET}`)
          })
        }) as PDFDict
      )
    );
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds a chained /Next action URI', async () => {
    const bytes = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 30],
          A: doc.context.obj({
            S: 'GoTo',
            Next: doc.context.obj({ S: 'URI', URI: PDFString.of(`https://x.invalid/${SECRET}`) })
          })
        }) as PDFDict
      )
    );
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds a markup annotation’s /RC when it has no /Contents', async () => {
    const bytes = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          RC: PDFString.of(`<body><p>${SECRET}</p></body>`)
        }) as PDFDict
      )
    );
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds an /RC carried as a stream rather than a string', async () => {
    const bytes = await docWith((doc, page) => {
      const rc = doc.context.register(
        doc.context.flateStream(new TextEncoder().encode(`<body>${SECRET}</body>`))
      );
      const annot = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30]
      }) as PDFDict;
      annot.set(PDFName.of('RC'), rc);
      annotate(doc, page, annot);
    });
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds a field’s /TU tooltip and /DV default value', async () => {
    for (const key of ['TU', 'DV'] as const) {
      const bytes = await docWith((doc, page) => {
        const widget = doc.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Tx',
          T: PDFString.of('field1'),
          Rect: [10, 10, 100, 30]
        }) as PDFDict;
        widget.set(PDFName.of(key), PDFString.of(SECRET));
        annotate(doc, page, widget);
      });
      expect(await haystack(bytes), `key ${key}`).toContain(SECRET.toLowerCase());
    }
  });

  it('finds a check box’s /V and /AS name states', async () => {
    for (const key of ['V', 'AS'] as const) {
      const bytes = await docWith((doc, page) => {
        const widget = doc.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Btn',
          T: PDFString.of('box1'),
          Rect: [10, 10, 30, 30]
        }) as PDFDict;
        // A check box's value is a *name*, not a string — the shape the old
        // `PDFTextField`/`Dropdown`/`OptionList` pass could not express at all.
        widget.set(PDFName.of(key), PDFName.of(SECRET));
        annotate(doc, page, widget);
      });
      expect(await haystack(bytes), `key ${key}`).toContain(SECRET.toLowerCase());
    }
  });

  it('finds a value on a field with no widget on any page', async () => {
    const bytes = await docWith(doc => {
      const field = doc.context.register(
        doc.context.obj({
          FT: 'Tx',
          T: PDFString.of('orphan'),
          V: PDFString.of(SECRET)
        })
      );
      doc.catalog.set(
        PDFName.of('AcroForm'),
        doc.context.register(doc.context.obj({ Fields: [field] }))
      );
    });
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds a value on a child field reached through /Kids', async () => {
    const bytes = await docWith(doc => {
      const kid = doc.context.register(
        doc.context.obj({ T: PDFString.of('kid'), V: PDFString.of(SECRET) })
      );
      const parent = doc.context.register(
        doc.context.obj({ FT: 'Tx', T: PDFString.of('parent'), Kids: [kid] })
      );
      doc.catalog.set(
        PDFName.of('AcroForm'),
        doc.context.register(doc.context.obj({ Fields: [parent] }))
      );
    });
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());
  });

  it('finds a FileAttachment’s embedded file contents and its file name', async () => {
    for (const where of ['contents', 'name'] as const) {
      const bytes = await docWith((doc, page) => {
        const body = where === 'contents' ? `case notes: ${SECRET}\n` : 'case notes\n';
        const name = where === 'name' ? `${SECRET}.txt` : 'notes.txt';
        const efStream = doc.context.register(
          doc.context.flateStream(new TextEncoder().encode(body), { Type: 'EmbeddedFile' })
        );
        const filespec = doc.context.register(
          doc.context.obj({
            Type: 'Filespec',
            F: PDFString.of(name),
            UF: PDFString.of(name),
            EF: doc.context.obj({ F: efStream })
          })
        );
        const annot = doc.context.obj({
          Type: 'Annot',
          Subtype: 'FileAttachment',
          Rect: [10, 10, 30, 30]
        }) as PDFDict;
        annot.set(PDFName.of('FS'), filespec);
        annotate(doc, page, annot);
      });
      expect(await haystack(bytes), `secret in the ${where}`).toContain(SECRET.toLowerCase());
    }
  });

  it('still finds the /Contents it always found, and stays quiet on a clean file', async () => {
    const withContents = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          Contents: PDFString.of(SECRET)
        }) as PDFDict
      )
    );
    expect(await haystack(withContents)).toContain(SECRET.toLowerCase());

    const clean = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          Contents: PDFString.of('nothing to see')
        }) as PDFDict
      )
    );
    expect(await haystack(clean)).not.toContain(SECRET.toLowerCase());
  });

  it('does not wander out of the annotation into the page it sits on', async () => {
    // `/P` and `/AP` are deliberately not followed: a blind walk would collect
    // the whole document and make every verification fail.
    const bytes = await docWith((doc, page) => {
      page.drawText('ordinary page text');
      const annot = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        Contents: PDFString.of('a comment')
      }) as PDFDict;
      annot.set(PDFName.of('P'), page.ref);
      annotate(doc, page, annot);
    });
    expect(await processWorkerImpl.collectOffPageText(bytes)).toEqual(['a comment']);
  });
});

describe('the redaction strip step clears the same values (§1.4)', () => {
  /**
   * A widget over the mark whose field is *shared* with a second widget
   * elsewhere. The overlapping widget is deleted outright; the surviving one
   * keeps the field alive, so anything left on the parent walks straight out
   * into the output.
   */
  async function sharedFieldDocument(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const field = doc.context.obj({
      FT: 'Tx',
      T: PDFString.of('shared'),
      V: PDFString.of(SECRET),
      DV: PDFString.of(SECRET),
      TU: PDFString.of(`tooltip: ${SECRET}`)
    }) as PDFDict;
    const fieldRef = doc.context.register(field);

    const overlapping = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: [10, 10, 100, 40],
        Parent: fieldRef
      })
    );
    const elsewhere = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: [10, 250, 100, 280],
        Parent: fieldRef
      })
    );
    field.set(PDFName.of('Kids'), doc.context.obj([overlapping, elsewhere]));
    page.node.set(PDFName.of('Annots'), doc.context.obj([overlapping, elsewhere]));
    doc.catalog.set(
      PDFName.of('AcroForm'),
      doc.context.register(doc.context.obj({ Fields: [fieldRef] }))
    );
    return doc.save({ useObjectStreams: false });
  }

  it('clears /TU on a surviving shared parent field, not just /V and /DV', async () => {
    const bytes = await sharedFieldDocument();
    expect(await haystack(bytes)).toContain(SECRET.toLowerCase());

    const output = await processWorkerImpl.applyRedactions(
      bytes,
      [{ pageIndex: 0, x: 0, y: 0, width: 0.5, height: 0.25 }],
      undefined,
      undefined
    );

    // The whole point: after the redaction, the verifier finds nothing left to
    // fail on — because there genuinely is nothing left.
    expect(await haystack(output)).not.toContain(SECRET.toLowerCase());
    expect(new TextDecoder('latin1').decode(output)).not.toContain(SECRET);
  });

  it('leaves an annotation nowhere near the mark alone', async () => {
    const bytes = await docWith((doc, page) =>
      annotate(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [200, 200, 240, 240],
          Contents: PDFString.of('untouched note')
        }) as PDFDict
      )
    );
    const output = await processWorkerImpl.applyRedactions(
      bytes,
      [{ pageIndex: 0, x: 0, y: 0, width: 0.2, height: 0.2 }],
      undefined,
      undefined
    );
    expect(await haystack(output)).toContain('untouched note');
  });
});
