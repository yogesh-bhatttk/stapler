/**
 * CONV-5 — a decompression budget for the OOXML readers (.docx, .xlsx, .pptx).
 *
 * All three formats are ZIP packages, and a ZIP entry of zeros deflates about
 * 1000:1. Before this, `pptx-reader.ts` inflated every entry of the package —
 * including media it never reads — and `mammoth`/SheetJS inflate whatever the
 * archive lists. A 1.5 MB file could therefore allocate over a gigabyte inside
 * the convert worker, and because workers share the renderer process in Chrome,
 * running out of memory there kills the *tab*, not just the job.
 *
 * Two layers:
 *
 *  1. {@link assertZipWithinBudget} reads only the central directory — no
 *     inflation — and refuses a package that *declares* more entries or more
 *     uncompressed bytes than any real document needs.
 *  2. {@link inflateZipVetted} then inflates each wanted entry into a buffer
 *     one byte larger than its declared size, and refuses the package if any
 *     entry inflates to more (or less) than it declared. A lying directory can
 *     therefore never allocate past the budget the first check approved, and
 *     is refused rather than silently truncated (which is what fflate's own
 *     `unzipSync` does with an overflowing entry).
 *
 * jszip (inside mammoth) and SheetJS do not bound inflation by the declared
 * size at all, so they are never handed the original archive: the docx and xlsx
 * readers give them {@link repackStored} of the vetted entries — the same
 * bytes, stored uncompressed, so there is nothing left for them to inflate.
 */
import { formatBytes } from '../bytes';
import { inflateSync, zipSync } from 'fflate';
import { corrupt, unsupported } from '../errors';
import { tKey, translate } from '../i18n';

/** Total declared uncompressed bytes the readers will accept. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 256_000_000; // decimal: the refusal says "256 MB" (X-10)
/** Entries a package may list. A 500-slide deck with media is a few thousand. */
export const MAX_ZIP_ENTRIES = 10_000;

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
  /** Byte offset of the entry's local file header. */
  localOffset: number;
  /** General-purpose flag bit 0: traditional ZIP encryption. */
  encrypted: boolean;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_ENTRY_SIG = 0x02014b50;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
/** A little-endian u64 as a double. Exact up to 2^53, which is far past any cap here. */
function u64(b: Uint8Array, o: number): number {
  return u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;
}

/**
 * The package's central directory, or `null` when there is no readable one.
 *
 * `null` is not a refusal: the caller's own reader then reports the damaged
 * container in its usual words, exactly as before this guard existed. Stops
 * early (and returns what it has, flagged `truncated`) once more than
 * `maxEntries` are seen, so a directory of a million entries costs no more to
 * reject than one of ten thousand.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  maxEntries = MAX_ZIP_ENTRIES
): { entries: ZipEntryInfo[]; truncated: boolean } | null {
  // The EOCD record is 22 bytes plus a comment of at most 65535.
  const minStart = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  let count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(bytes, locator) !== ZIP64_LOCATOR_SIG) return null;
    const z64 = u64(bytes, locator + 8);
    if (z64 + 56 > bytes.length || u32(bytes, z64) !== ZIP64_EOCD_SIG) return null;
    count = u64(bytes, z64 + 32);
    offset = u64(bytes, z64 + 48);
  }

  const entries: ZipEntryInfo[] = [];
  const decoder = new TextDecoder();
  let p = offset;
  // Walked by signature rather than trusting `count`: the count is a u16 in a
  // plain ZIP and can be anything in a crafted one.
  while (p + 46 <= bytes.length && u32(bytes, p) === CD_ENTRY_SIG) {
    if (entries.length >= maxEntries) return { entries, truncated: true };
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    let compressedSize = u32(bytes, p + 20);
    let uncompressedSize = u32(bytes, p + 24);
    let localOffset = u32(bytes, p + 42);
    const nameLength = u16(bytes, p + 28);
    const extraLength = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength > bytes.length) break;
    const name = decoder.decode(bytes.subarray(nameStart, extraStart));

    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      // ZIP64 extended information: the 8-byte fields appear in this order,
      // each only when its 32-bit counterpart is saturated.
      for (let e = extraStart; e + 4 <= extraStart + extraLength;) {
        const id = u16(bytes, e);
        const size = u16(bytes, e + 2);
        if (id === 0x0001) {
          let f = e + 4;
          if (uncompressedSize === 0xffffffff && f + 8 <= e + 4 + size) {
            uncompressedSize = u64(bytes, f);
            f += 8;
          }
          if (compressedSize === 0xffffffff && f + 8 <= e + 4 + size) {
            compressedSize = u64(bytes, f);
            f += 8;
          }
          if (localOffset === 0xffffffff && f + 8 <= e + 4 + size) {
            localOffset = u64(bytes, f);
          }
          break;
        }
        e += 4 + size;
      }
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localOffset,
      encrypted: (flags & 1) === 1
    });
    p = extraStart + extraLength + commentLength;
  }
  // Nothing walkable where the record says the directory is: a damaged
  // directory, and the reader's own error is the better message.
  if (entries.length === 0 && count > 0) return null;
  return { entries, truncated: false };
}

function megabytes(n: number): string {
  return formatBytes(n);
}

/**
 * Throws a clear refusal when the package declares more than the budget.
 *
 * `kind` is the user's word for the file ("Word document", "workbook",
 * "presentation"). It goes into the error's diagnostic context only: the
 * messages say "this file", so each is one whole translatable sentence instead
 * of a sentence with a noun spliced into it (AUDIT UI-8). `include` narrows the size total to the entries the caller
 * will actually inflate — the pptx reader skips media it never reads, so a deck
 * with a large unreferenced video is not refused for bytes nobody touches. The
 * entry count always covers the whole package: that is the directory's own cost.
 */
export function assertZipWithinBudget(
  bytes: Uint8Array,
  kind: string,
  include: (name: string) => boolean = () => true,
  limits: { maxBytes?: number; maxEntries?: number } = {}
): ZipEntryInfo[] | null {
  const maxBytes = limits.maxBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const directory = readZipDirectory(bytes, maxEntries);
  if (!directory) return null;
  if (directory.truncated) {
    throw unsupported(
      translate(
        'This file lists more than {limit} files inside it, ' +
          'which no real document needs — it looks like a decompression bomb. Nothing was read.',
        { limit: maxEntries.toLocaleString('en-US') }
      ),
      { entryLimit: maxEntries, kind }
    );
  }
  let total = 0;
  for (const entry of directory.entries) {
    if (!include(entry.name)) continue;
    total += entry.uncompressedSize;
    if (total > maxBytes) {
      throw unsupported(
        translate(
          'This file would expand to more than {size} when unpacked, which is ' +
            'more than Stapler will decompress in the browser (it may be a decompression bomb). ' +
            'Nothing was read. Re-save it with smaller embedded media and try again.',
          { size: megabytes(maxBytes) }
        ),
        { byteLimit: maxBytes, kind }
      );
    }
  }
  return directory.entries;
}

const LOCAL_HEADER_SIG = 0x04034b50;

/**
 * Inflates the wanted entries of a package, each bounded by — and checked
 * against — its declared size (CONV-5, second layer; see the module comment).
 *
 * Runs {@link assertZipWithinBudget} first over the same entries.
 * Returns `null` when there is no readable central directory, so the caller can
 * report the damaged container in its own words. Directory entries are skipped.
 */
export function inflateZipVetted(
  bytes: Uint8Array,
  kind: string,
  options: {
    /** Entries to inflate (and to count against the size budget). Default: all. */
    include?: (name: string) => boolean;
    /** Sees every included entry before it is inflated; may throw to refuse it. */
    inspect?: (entry: ZipEntryInfo) => void;
    maxBytes?: number;
    maxEntries?: number;
  } = {}
): Record<string, Uint8Array> | null {
  const include = options.include ?? (() => true);
  const wanted = (name: string) => !name.endsWith('/') && include(name);
  const entries = assertZipWithinBudget(bytes, kind, wanted, options);
  if (!entries) return null;
  /** `message` is one of the whole-sentence keys below, with `{name}` for the part. */
  const damaged = (name: string, message: string) =>
    corrupt(translate(message, { name }), { entry: name, kind });

  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (!wanted(entry.name)) continue;
    options.inspect?.(entry);
    if (entry.encrypted) {
      throw unsupported(
        translate(
          'This file is password-protected, which Stapler cannot open. Save an unprotected copy ' +
            'and try again.'
        ),
        { kind }
      );
    }
    const at = entry.localOffset;
    if (at + 30 > bytes.length || u32(bytes, at) !== LOCAL_HEADER_SIG) {
      throw damaged(
        entry.name,
        tKey('This file is damaged: the part {name} points outside the file. Nothing was read.')
      );
    }
    const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
    const end = start + entry.compressedSize;
    if (end > bytes.length) {
      throw damaged(
        entry.name,
        tKey('This file is damaged: the part {name} is cut short. Nothing was read.')
      );
    }
    const raw = bytes.subarray(start, end);

    let data: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw damaged(
          entry.name,
          tKey('This file is damaged: the part {name} has inconsistent sizes. Nothing was read.')
        );
      }
      data = raw.slice();
    } else if (entry.method === 8) {
      try {
        // One byte of headroom is what detects an entry that inflates past its
        // declared size: with a fixed output buffer fflate stops writing at the
        // end of it, so a result that fills the extra byte proves the lie.
        data = inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize + 1) });
      } catch {
        throw damaged(
          entry.name,
          tKey('This file is damaged: the part {name} could not be decompressed. Nothing was read.')
        );
      }
      if (data.length > entry.uncompressedSize) {
        throw unsupported(
          translate(
            'This file understates how large its part {name} is when unpacked — the ' +
              'signature of a decompression bomb — so nothing was read.',
            { name: entry.name }
          ),
          { entry: entry.name, declared: entry.uncompressedSize, kind }
        );
      }
      if (data.length < entry.uncompressedSize) {
        throw damaged(
          entry.name,
          tKey(
            'This file is damaged: the part {name} is shorter than its declared size. ' +
              'Nothing was read.'
          )
        );
      }
    } else {
      throw unsupported(
        translate(
          'This file uses a ZIP compression method ({method}) Stapler cannot read. ' +
            'Re-save it from Office and try again.',
          { method: entry.method }
        ),
        { method: entry.method, kind }
      );
    }
    files[entry.name] = data;
  }
  return files;
}

/**
 * The vetted entries re-packed as a ZIP with every entry *stored*: what the
 * docx/xlsx readers hand to mammoth (jszip) and SheetJS, whose inflation is
 * not bounded by the declared size. Stored entries leave them nothing to
 * inflate, so neither can allocate more than what was already vetted.
 */
export function repackStored(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 0 });
}
