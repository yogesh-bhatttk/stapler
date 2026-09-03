/**
 * F-04 — the platform adapter contract.
 *
 * `core/` and `ui/` never touch `chrome.*` or the File System Access API directly;
 * they go through this interface so the same code builds as an extension and as the
 * website twin (PLAN §2.2). The ESLint boundary rule and the PostToolUse hook both
 * enforce that.
 *
 * The previous interface had two methods, `openFiles` and `saveFile`, so
 * save-over-original, directory output, and the Recents list were unreachable — five
 * of the seven capabilities F-04 asks for did not exist.
 */

export interface OpenedFile {
  /** Stable within a session; the Recents key when persistable. */
  id: string;
  name: string;
  getFile: () => Promise<File>;
  /** True when {@link PlatformAdapter.persistHandle} can remember this file. */
  persistable: boolean;
  /** True when {@link PlatformAdapter.saveOver} can write back to it. */
  writable: boolean;
}

export interface OutputDirectory {
  name: string;
  write: (fileName: string, bytes: Uint8Array) => Promise<void>;
}

export interface OpenOptions {
  multiple?: boolean;
  /** MIME type → extensions, e.g. `{'application/pdf': ['.pdf']}`. */
  accept?: Record<string, string[]>;
}

export interface RecentEntry {
  id: string;
  name: string;
  openedAt: number;
}

export interface PlatformAdapter {
  readonly kind: 'extension' | 'web';
  /** True when files can be written without a download prompt each time. */
  readonly supportsFileSystemAccess: boolean;

  openFiles(options?: OpenOptions): Promise<OpenedFile[]>;
  /** Null when unsupported or cancelled — callers then fall back to a ZIP. */
  openDirectory(): Promise<OutputDirectory | null>;
  /** Save through a picker. False if the user cancelled. */
  saveFileAs(bytes: Uint8Array, suggestedName: string): Promise<boolean>;
  /** Overwrite the file a handle came from (DOC-05, save-over-original). */
  saveOver(fileId: string, bytes: Uint8Array): Promise<boolean>;

  persistHandle(file: OpenedFile): Promise<void>;
  restoreHandles(): Promise<RecentEntry[]>;
  /** Re-opens a persisted handle, re-prompting for permission if needed. */
  reopenHandle(id: string): Promise<OpenedFile | null>;
  revokeHandle(id: string): Promise<void>;

  /** Reads an image from the OS clipboard, or null if empty/refused. */
  readClipboardImage(): Promise<File | null>;
}

/** `accept` map → the `accept` attribute of an `<input type=file>`. */
export function acceptToInputAccept(accept: Record<string, string[]> | undefined): string {
  if (!accept) return '';
  return Object.entries(accept)
    .flatMap(([mime, extensions]) => [mime, ...extensions])
    .join(',');
}

export const IMAGES_ONLY: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/heic': ['.heic'],
  'image/tiff': ['.tiff', '.tif']
};

export const PDF_AND_IMAGES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  ...IMAGES_ONLY
};

/** CNV-09 — the one MIME type an OOXML Word document has. */
export const DOCX_ONLY: Record<string, string[]> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

/**
 * CNV-11 — the one MIME type an OOXML Excel workbook has.
 *
 * `.xls`, `.xlsm` and `.csv` are deliberately absent: the reader refuses a legacy
 * binary workbook outright (see `xlsx-reader.ts`), and offering a file type the
 * next screen rejects is worse than not offering it.
 */
export const XLSX_ONLY: Record<string, string[]> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
};

/**
 * CNV-13 — the one MIME type an OOXML PowerPoint presentation has.
 *
 * `.ppt` and `.pps` are deliberately absent for the same reason `.xls` is above:
 * a legacy binary presentation is an OLE2 container the reader refuses by name
 * (see `pptx-reader.ts`), and offering a file type the next screen rejects is
 * worse than not offering it. `.pptm` is absent too — a macro-enabled deck is a
 * valid ZIP this reader could open, but its macros are the reason the user has
 * it, and nothing here would carry them.
 */
export const PPTX_ONLY: Record<string, string[]> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx']
};
