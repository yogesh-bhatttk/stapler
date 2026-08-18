import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFHexString,
  PDFNumber,
  PDFString,
  PDFRef,
  PDFStream,
  PDFObject,
  PDFPage
} from 'pdf-lib';
import {
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  Statement,
  Token
} from './interpreter';
import { decodeStream } from './interpreter';

function utf16BeHex(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return hex;
}

function encodeString(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

export async function applyAltTextToDoc(
  doc: PDFDocument,
  altTexts: Record<string, string> // key is `${pageIndex}:${objectNumber}` or `${pageIndex}:${xObjectName}`
): Promise<void> {
  const pages = doc.getPages();

  // 1. Set up MarkInfo
  let markInfo = doc.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  if (!markInfo) {
    markInfo = doc.context.obj({ Marked: true });
    doc.catalog.set(PDFName.of('MarkInfo'), markInfo);
  } else {
    markInfo.set(PDFName.of('Marked'), doc.context.obj(true));
  }

  let structTreeRoot = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
  // The live array object registered in the document, not a snapshot: `doc.context.obj([])`
  // copies whatever a plain JS array holds *at that instant*, so pushing to the JS array
  // afterward never reaches the PDFArray already wired into the tree. Every mutation below
  // therefore goes through this array's own `.push`/`.set`, not a detached JS array.
  let numsPdfArray: PDFArray;

  if (!structTreeRoot) {
    numsPdfArray = doc.context.obj([]) as unknown as PDFArray;
    const numsDict = doc.context.obj({ Nums: numsPdfArray });

    structTreeRoot = doc.context.obj({
      Type: 'StructTreeRoot',
      K: [],
      ParentTree: numsDict
    });
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRoot);
  } else {
    const pTree = structTreeRoot.lookupMaybe(PDFName.of('ParentTree'), PDFDict);
    if (pTree) {
      const nums = pTree.lookupMaybe(PDFName.of('Nums'), PDFArray);
      if (nums) {
        numsPdfArray = nums;
      } else {
        numsPdfArray = doc.context.obj([]) as unknown as PDFArray;
        pTree.set(PDFName.of('Nums'), numsPdfArray);
      }
    } else {
      numsPdfArray = doc.context.obj([]) as unknown as PDFArray;
      const numsDict = doc.context.obj({ Nums: numsPdfArray });
      structTreeRoot.set(PDFName.of('ParentTree'), numsDict);
    }
  }

  // Every integer already used as a structure-parent key, so a new page never
  // collides with one the document already had.
  const usedKeys = new Set<number>();
  for (let i = 0; i < numsPdfArray.size(); i += 2) {
    const key = numsPdfArray.get(i);
    if (key instanceof PDFNumber) usedKeys.add(key.asNumber());
  }

  // 3. Process each page
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);

    // We resolve the drawn image name to an object number, but accept either the
    // stable `${pageIndex}:${xObjectName}` editor key or the legacy object-number
    // form when looking up the text to attach.
    const nameToObjectNum = new Map<string, number>();
    const objectNumToName = new Map<number, string>();
    if (xobjects) {
      for (const [key, value] of xobjects.entries()) {
        if (value instanceof PDFRef) {
          const name = key.asString().replace(/^\//, '');
          nameToObjectNum.set(name, value.objectNumber);
          objectNumToName.set(value.objectNumber, name);
        }
      }
    }

    // Get content stream
    let rawBytes: Uint8Array;

    const contents = page.node.get(PDFName.of('Contents'));
    if (contents instanceof PDFRef) {
      const stream = doc.context.lookup(contents, PDFStream);
      rawBytes = stream.getContents();
      const filter = stream.dict.lookup(PDFName.of('Filter'));
      if (
        filter === PDFName.of('FlateDecode') ||
        (filter instanceof PDFArray && filter.get(0) === PDFName.of('FlateDecode'))
      ) {
        rawBytes = await decodeStream(rawBytes);
      }
    } else if (contents instanceof PDFArray) {
      // Multiple content streams - unsupported by our simple editor for now
      // A more robust implementation would merge them or process each
      continue;
    } else {
      continue;
    }

    const tokens = tokenizeContentStream(rawBytes);
    const statements = parseContentStream(tokens);

    let mcid = 0;
    // Find highest existing MCID to avoid collisions
    for (const stmt of statements) {
      const op = String.fromCharCode(...stmt.operator.bytes);
      if (op === 'BDC' && stmt.operands.length === 2 && stmt.operands[1].type === 'dict_start') {
        // Very basic attempt to parse BDC props for MCID
        // In reality, property dictionaries can be references, but we do our best
        for (let i = 0; i < stmt.operands.length - 1; i++) {
          if (
            stmt.operands[i].type === 'name' &&
            String.fromCharCode(...stmt.operands[i].bytes) === '/MCID'
          ) {
            const num = parseInt(String.fromCharCode(...stmt.operands[i + 1].bytes), 10);
            if (!isNaN(num) && num >= mcid) {
              mcid = num + 1;
            }
          }
        }
      }
    }

    const modifiedStatements: Statement[] = [];
    const structElems: PDFDict[] = [];
    /** Which marked-content id each new element owns, for the ParentTree value. */
    const structElemsByMcid: { mcid: number; elem: PDFDict }[] = [];

    for (const stmt of statements) {
      const op = String.fromCharCode(...stmt.operator.bytes);
      if (op === 'Do' && stmt.operands.length === 1 && stmt.operands[0].type === 'name') {
        const xobjName = String.fromCharCode(...stmt.operands[0].bytes).replace(/^\//, '');
        const objNum = nameToObjectNum.get(xobjName);

        if (objNum !== undefined) {
          const key = `${pageIndex}:${objNum}`;
          const altText = altTexts[key] ?? altTexts[`${pageIndex}:${xobjName}`];

          if (altText) {
            // Wrap in BDC ... EMC
            const bdcOperands: Token[] = [
              { type: 'name', bytes: encodeString('/Figure') },
              { type: 'dict_start', bytes: encodeString('<<') },
              { type: 'name', bytes: encodeString('/MCID') },
              { type: 'number', bytes: encodeString(mcid.toString()) },
              { type: 'dict_end', bytes: encodeString('>>') }
            ];
            modifiedStatements.push({
              operands: bdcOperands,
              operator: { type: 'operator', bytes: encodeString('BDC') }
            });

            modifiedStatements.push(stmt);

            modifiedStatements.push({
              operands: [],
              operator: { type: 'operator', bytes: encodeString('EMC') }
            });

            // Create StructElem
            const structElem = doc.context.obj({
              Type: 'StructElem',
              S: 'Figure',
              P: structTreeRoot,
              Pg: page.ref,
              K: mcid,
              Alt: PDFHexString.of(utf16BeHex(altText))
            });
            structElems.push(structElem);
            structElemsByMcid.push({ mcid, elem: structElem });

            mcid++;
            continue;
          }
        }
      }

      modifiedStatements.push(stmt);
    }

    if (structElems.length > 0) {
      // 1. Update content stream
      const newBytes = serializeStatements(modifiedStatements);
      const newStream = doc.context.flateStream(newBytes);
      page.node.set(PDFName.of('Contents'), doc.context.register(newStream));

      // 2. Add to ParentTree, keyed by the page's /StructParents integer.
      //
      // This used to be keyed by page *index*, and no page carried a
      // /StructParents entry at all — so a spec-conformant reader (PDF 32000-1
      // §14.7.4.4: "the value of the page's StructParents entry shall be used as
      // the key into the structure parent tree") had no way in, and any page
      // index that collided with an existing key silently overwrote it.
      const existing = page.node.lookupMaybe(PDFName.of('StructParents'), PDFNumber);
      const structParents = existing ? existing.asNumber() : nextStructParentKey(usedKeys);
      usedKeys.add(structParents);
      page.node.set(PDFName.of('StructParents'), doc.context.obj(structParents));

      // The value is indexed by MCID, so the array must be dense from 0: element
      // n is the structure element owning marked-content id n on this page.
      const byMcid: PDFObject[] = [];
      for (const { mcid: id, elem } of structElemsByMcid) {
        while (byMcid.length < id) byMcid.push(doc.context.obj(null));
        byMcid[id] = doc.context.register(elem);
      }
      const pageRefsArray = doc.context.register(doc.context.obj(byMcid));
      // Replace rather than append when the key is already in the tree: duplicate
      // keys in a number tree are invalid and readers take the first they find.
      let replaced = false;
      for (let i = 0; i + 1 < numsPdfArray.size(); i += 2) {
        const key = numsPdfArray.get(i);
        if (key instanceof PDFNumber && key.asNumber() === structParents) {
          numsPdfArray.set(i + 1, pageRefsArray);
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        numsPdfArray.push(doc.context.obj(structParents));
        numsPdfArray.push(pageRefsArray);
      }

      // 3. Add to StructTreeRoot's K array
      let kArr = structTreeRoot.lookupMaybe(PDFName.of('K'), PDFArray);
      if (!kArr) {
        kArr = doc.context.obj([]) as unknown as PDFArray;
        structTreeRoot.set(PDFName.of('K'), kArr);
      }
      for (const e of structElems) {
        kArr.push(doc.context.register(e));
      }
    }
  }
}

/** The lowest non-negative integer not already used as a structure-parent key. */
function nextStructParentKey(used: Set<number>): number {
  let key = 0;
  while (used.has(key)) key += 1;
  return key;
}

/* ------------------------------------------------------------------ *
 * ACC-01 — reading alt-text back.
 *
 * The writer above was only half the feature: nothing anywhere read a structure
 * tree, so re-opening a file Stapler had itself tagged showed every alt-text box
 * empty, and a user's second pass over a document silently started from nothing.
 *
 * The map this returns is keyed exactly the way `applyAltTextToDoc` expects its
 * input — `${pageIndex}:${objectNumber}` — so a round trip is symmetric.
 * ------------------------------------------------------------------ */

/** Decoded content bytes of a page, joining a `/Contents` array if there is one. */
async function pageContentBytes(doc: PDFDocument, page: PDFPage): Promise<Uint8Array | null> {
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const parts = resolved instanceof PDFArray ? resolved.asArray() : [resolved];

  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const stream = part instanceof PDFRef ? doc.context.lookup(part) : part;
    if (!(stream instanceof PDFStream)) continue;
    let bytes: Uint8Array;
    try {
      bytes = stream.getContents();
    } catch {
      continue;
    }
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    if (
      filter === PDFName.of('FlateDecode') ||
      (filter instanceof PDFArray && filter.get(0) === PDFName.of('FlateDecode'))
    ) {
      try {
        bytes = await decodeStream(bytes);
      } catch {
        continue;
      }
    }
    chunks.push(bytes, new Uint8Array([0x0a]));
  }
  if (chunks.length === 0) return null;

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/**
 * Which image XObject each marked-content id on the page draws.
 *
 * A structure element points at an MCID, not at an object number, so recovering
 * "this alt text describes that image" means reading the page's own marked
 * content back — the same information the writer put there.
 */
function mcidToObjectNumber(
  statements: Statement[],
  nameToObjectNum: Map<string, number>
): Map<number, number> {
  const result = new Map<number, number>();
  const open: (number | null)[] = [];

  for (const stmt of statements) {
    const op = String.fromCharCode(...stmt.operator.bytes);
    if (op === 'BDC' || op === 'BMC') {
      let mcid: number | null = null;
      for (let i = 0; i < stmt.operands.length - 1; i++) {
        if (
          stmt.operands[i].type === 'name' &&
          String.fromCharCode(...stmt.operands[i].bytes) === '/MCID'
        ) {
          const parsed = parseInt(String.fromCharCode(...stmt.operands[i + 1].bytes), 10);
          if (!Number.isNaN(parsed)) mcid = parsed;
        }
      }
      open.push(mcid);
      continue;
    }
    if (op === 'EMC') {
      open.pop();
      continue;
    }
    if (op === 'Do' && stmt.operands.length === 1 && stmt.operands[0].type === 'name') {
      // The innermost open marked-content id that has one.
      let mcid: number | null = null;
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i] !== null) {
          mcid = open[i];
          break;
        }
      }
      if (mcid === null) continue;
      const name = String.fromCharCode(...stmt.operands[0].bytes).replace(/^\//, '');
      const objNum = nameToObjectNum.get(name);
      if (objNum !== undefined && !result.has(mcid)) result.set(mcid, objNum);
    }
  }

  return result;
}

/** Every `/Alt`-carrying structure element in the tree, with the page it marks. */
function collectAltElements(doc: PDFDocument): { pgRef?: PDFRef; alt: string; mcids: number[] }[] {
  const root = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
  if (!root) return [];

  const found: { pgRef?: PDFRef; alt: string; mcids: number[] }[] = [];
  const seen = new Set<PDFDict>();
  const queue: PDFObject[] = [root.get(PDFName.of('K')) ?? PDFName.of('K')];

  const push = (value: PDFObject | undefined) => {
    if (value) queue.push(value);
  };

  let guard = 0;
  while (queue.length > 0) {
    // A malformed document can point a structure element at its own ancestor.
    if (guard++ > 100_000) break;
    const raw = queue.pop()!;
    const node = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;

    if (node instanceof PDFArray) {
      for (const child of node.asArray()) push(child);
      continue;
    }
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);

    const altValue = node.get(PDFName.of('Alt'));
    const alt =
      altValue instanceof PDFString || altValue instanceof PDFHexString
        ? altValue.decodeText()
        : undefined;

    if (alt) {
      const pg = node.get(PDFName.of('Pg'));
      const kids = node.get(PDFName.of('K'));
      const resolvedKids = kids instanceof PDFRef ? doc.context.lookup(kids) : kids;
      const mcids: number[] = [];
      const collectMcid = (value: PDFObject | undefined) => {
        if (value instanceof PDFNumber) mcids.push(value.asNumber());
        else if (value instanceof PDFDict) {
          const nested = value.get(PDFName.of('MCID'));
          if (nested instanceof PDFNumber) mcids.push(nested.asNumber());
        }
      };
      if (resolvedKids instanceof PDFArray) {
        for (const kid of resolvedKids.asArray()) collectMcid(kid);
      } else {
        collectMcid(resolvedKids ?? undefined);
      }
      found.push({ pgRef: pg instanceof PDFRef ? pg : undefined, alt, mcids });
    }

    push(node.get(PDFName.of('K')) ?? undefined);
  }

  return found;
}

/**
 * Recovers the alt-text already stored in `doc`, keyed `${pageIndex}:${objectNumber}`.
 *
 * The tree is walked from `/StructTreeRoot` rather than through `/ParentTree`,
 * deliberately: the parent tree is an index for finding a *page's* elements
 * quickly, and a document written by a tool that got it wrong (this one, until
 * now) still has a perfectly readable tree. Elements are matched back to images
 * through their `/Pg` reference and the page's own marked content.
 */
export async function readAltTextFromDoc(doc: PDFDocument): Promise<Record<string, string>> {
  const elements = collectAltElements(doc);
  if (elements.length === 0) return {};

  const result: Record<string, string> = {};
  const pages = doc.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const forPage = elements.filter(
      e => e.pgRef && page.ref && e.pgRef.objectNumber === page.ref.objectNumber
    );
    if (forPage.length === 0) continue;

    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const nameToObjectNum = new Map<string, number>();
    const objectNumToName = new Map<number, string>();
    if (xobjects) {
      for (const [key, value] of xobjects.entries()) {
        if (value instanceof PDFRef) {
          const name = key.asString().replace(/^\//, '');
          nameToObjectNum.set(name, value.objectNumber);
          objectNumToName.set(value.objectNumber, name);
        }
      }
    }

    const bytes = await pageContentBytes(doc, page);
    if (!bytes) continue;
    const byMcid = mcidToObjectNumber(
      parseContentStream(tokenizeContentStream(bytes)),
      nameToObjectNum
    );

    for (const element of forPage) {
      for (const mcid of element.mcids) {
        const objNum = byMcid.get(mcid);
        if (objNum === undefined) continue;
        const name = objectNumToName.get(objNum);
        result[`${pageIndex}:${objNum}`] = element.alt;
        if (name) result[`${pageIndex}:${name}`] = element.alt;
      }
    }
  }

  return result;
}

/** Convenience: read alt-text straight from bytes. */
export async function readAltText(bytes: Uint8Array): Promise<Record<string, string>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return readAltTextFromDoc(doc);
}
