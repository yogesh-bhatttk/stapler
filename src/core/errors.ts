/**
 * F-07 — error taxonomy and in-memory diagnostics.
 *
 * Every failure the user can reach is one of five kinds, each with copy that says
 * what happened and what to do next. Nothing here ever leaves the tab: the log is
 * a bounded in-memory ring buffer and the only way it moves is the user pressing
 * "copy diagnostic" (PLAN §5.4).
 *
 * Errors cross a Comlink boundary, which structured-clones them and drops the
 * prototype, so the `kind` is carried as a plain data field and re-hydrated with
 * {@link fromUnknown} on the receiving side rather than with `instanceof`.
 */

import { tKey } from './i18n/key';

export type ErrorKind =
  | 'UnsupportedFeature'
  | 'CorruptDocument'
  | 'Encrypted'
  | 'OutOfMemory'
  | 'UserCancelled'
  | 'InternalError';

export interface StaplerErrorCopy {
  /** Short sentence naming what happened, in the user's terms. */
  title: string;
  /** What they can do about it. */
  recovery: string;
}

const COPY: Record<ErrorKind, StaplerErrorCopy> = {
  UnsupportedFeature: {
    title: tKey('This PDF uses a feature Stapler cannot process.'),
    recovery: tKey(
      'The file is untouched. The details below say which feature and what to do instead.'
    )
  },
  CorruptDocument: {
    title: tKey('This file is damaged or incomplete.'),
    recovery: tKey('Try re-downloading or re-exporting it. Nothing was written.')
  },
  Encrypted: {
    title: tKey('This PDF is password-protected.'),
    recovery: tKey(
      'Stapler cannot decrypt files. Open it in a viewer that has the password, save an unprotected copy, then bring that copy here.'
    )
  },
  OutOfMemory: {
    title: tKey('This document is too large to process in one pass.'),
    recovery: tKey('Split it into smaller files, or close other documents and try again.')
  },
  UserCancelled: {
    title: tKey('Cancelled.'),
    recovery: tKey('Nothing was changed.')
  },
  InternalError: {
    title: tKey('Something went wrong inside Stapler.'),
    recovery: tKey(
      'Your document was not modified. Copy the diagnostic below if you want to file an issue.'
    )
  }
};

export class StaplerError extends Error {
  readonly kind: ErrorKind;
  /** Machine-readable extra context. Never contains document bytes. */
  readonly context: Record<string, string | number | boolean>;
  /** Set so the kind survives structured cloning across a worker boundary. */
  readonly isStaplerError = true;

  constructor(
    kind: ErrorKind,
    detail: string,
    context: Record<string, string | number | boolean> = {}
  ) {
    super(detail);
    this.name = `StaplerError(${kind})`;
    this.kind = kind;
    this.context = context;
  }

  get copy(): StaplerErrorCopy {
    return COPY[this.kind];
  }
}

export const unsupported = (detail: string, context?: Record<string, string | number | boolean>) =>
  new StaplerError('UnsupportedFeature', detail, context);

export const corrupt = (detail: string, context?: Record<string, string | number | boolean>) =>
  new StaplerError('CorruptDocument', detail, context);

export const encrypted = (detail: string, context?: Record<string, string | number | boolean>) =>
  new StaplerError('Encrypted', detail, context);

export const cancelled = () => new StaplerError('UserCancelled', 'Operation cancelled by user');

export const internal = (detail: string, context?: Record<string, string | number | boolean>) =>
  new StaplerError('InternalError', detail, context);

/** True when the value is a cancellation, however it crossed a boundary. */
export function isCancellation(value: unknown): boolean {
  if (value instanceof StaplerError) return value.kind === 'UserCancelled';
  if (value instanceof DOMException && value.name === 'AbortError') return true;
  if (typeof value === 'object' && value !== null) {
    const v = value as { kind?: unknown; name?: unknown };
    return v.kind === 'UserCancelled' || v.name === 'AbortError';
  }
  return false;
}

/**
 * Normalises anything thrown — including a structured-cloned StaplerError that
 * has lost its prototype — into a StaplerError with a real kind.
 */
export function fromUnknown(value: unknown): StaplerError {
  if (value instanceof StaplerError) return value;

  if (typeof value === 'object' && value !== null) {
    const v = value as {
      isStaplerError?: boolean;
      kind?: ErrorKind;
      message?: string;
      context?: Record<string, string | number | boolean>;
      name?: string;
    };
    if (v.isStaplerError && v.kind && Object.hasOwn(COPY, v.kind)) {
      return new StaplerError(v.kind, v.message ?? '', v.context ?? {});
    }
    // Comlink's default error transfer handler only copies `message`, `name` and
    // `stack` across a worker boundary (it structured-clones nothing else off an
    // Error instance) — `isStaplerError`/`kind`/`context` never survive the trip,
    // so the check above only ever matches a same-thread throw. `name` does
    // survive, and the constructor sets it to `StaplerError(<kind>)`, so a
    // worker-thrown StaplerError is still recoverable from that string instead of
    // falling through to a generic "Something went wrong" below.
    const nameMatch = /^StaplerError\((\w+)\)$/.exec(v.name ?? '');
    // `hasOwn`, not `in`: `in` also matches inherited Object.prototype keys
    // (`constructor`, `toString`, …), which `\w+` can match literally.
    if (nameMatch && Object.hasOwn(COPY, nameMatch[1])) {
      return new StaplerError(nameMatch[1] as ErrorKind, v.message ?? '', v.context ?? {});
    }
    if (v.name === 'AbortError') return cancelled();
    // Chrome surfaces allocation failures as a RangeError or a bare "out of memory".
    if (/out of memory|allocation (failed|size overflow)/i.test(v.message ?? '')) {
      return new StaplerError('OutOfMemory', v.message ?? 'Allocation failed');
    }
  }

  if (value instanceof Error) return internal(value.message, { originalName: value.name });
  return internal(String(value));
}

/* ------------------------------------------------------------------ *
 * In-memory diagnostic log. Never transmitted, never persisted.
 * ------------------------------------------------------------------ */

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

const MAX_LOG_ENTRIES = 200;
const log: LogEntry[] = [];

export function logEvent(level: LogEntry['level'], scope: string, message: string): void {
  log.push({ at: Date.now(), level, scope, message });
  if (log.length > MAX_LOG_ENTRIES) log.shift();
}

export function logError(scope: string, value: unknown): StaplerError {
  const err = fromUnknown(value);
  logEvent('error', scope, `${err.kind}: ${err.message}`);
  return err;
}

/** Extensions of the files Stapler opens or writes — what a leaked file name ends in. */
const FILE_EXTENSIONS =
  'pdf|png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|markdown|csv|tsv|html?|zip|jp2|j2k|traineddata(?:\\.gz)?';

/** A network URL (kept: the model URL is what a download diagnostic is about). */
const URL_PATTERN = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const PATH_RULES: [RegExp, string][] = [
  // file:///…, C:\Users\…, C:/…, \\server\share\…
  [/(?:file:\/\/)?(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/g, '[path]'],
  // /home/…, /Users/… — any absolute POSIX path with two or more segments.
  [/(?<![\w.])\/(?:[^\s/"'<>]+\/)+[^\s/"'<>]*/g, '[path]'],
  // folder/sub/name.pdf, up to its extension even across spaces in the name.
  [new RegExp(`[^\\s"'<>]*[/\\\\][^"'<>\\n]*?\\.(?:${FILE_EXTENSIONS})\\b`, 'gi'), '[path]'],
  // A bare name.pdf. (A name with spaces keeps its leading words: there is no
  // telling where it starts. Callers must not log names in the first place.)
  [new RegExp(`[^\\s"'<>/\\\\:]+\\.(?:${FILE_EXTENSIONS})\\b`, 'gi'), '[file]']
];

/**
 * Audit 2026-10-10 S5 — defence in depth for "no file names": whatever a
 * caller put in a log line or an error message, anything path- or
 * file-name-shaped is replaced before it reaches the diagnostic — absolute
 * paths (Windows drive or UNC, POSIX, `file:` URLs), relative paths with a
 * separator, and names ending in a document or image extension. Network URLs
 * are left as they are.
 */
export function scrubPaths(text: string): string {
  const scrub = (part: string) =>
    PATH_RULES.reduce((out, [pattern, label]) => out.replace(pattern, label), part);
  let out = '';
  let at = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    out += scrub(text.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + scrub(text.slice(at));
}

/**
 * A plain-text diagnostic the user can paste into an issue. Contains the log,
 * the error, and the environment — no file names, no document content. File
 * names and paths that reached a message anyway are scrubbed ({@link scrubPaths}).
 */
export function buildDiagnostic(err?: StaplerError): string {
  const lines = [
    `Stapler diagnostic`,
    `generated: ${new Date().toISOString()}`,
    `userAgent: ${typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent}`,
    `cores: ${typeof navigator === 'undefined' ? 'n/a' : navigator.hardwareConcurrency}`,
    ''
  ];
  if (err) {
    lines.push(`error: ${err.kind}`, `detail: ${scrubPaths(err.message)}`);
    const ctx = Object.entries(err.context);
    if (ctx.length) {
      lines.push(`context: ${scrubPaths(ctx.map(([k, v]) => `${k}=${v}`).join(' '))}`);
    }
    lines.push('');
  }
  lines.push(`log (${log.length} most recent events):`);
  for (const e of log) {
    lines.push(
      `  ${new Date(e.at).toISOString()} ${e.level.padEnd(5)} ${e.scope}: ${scrubPaths(e.message)}`
    );
  }
  return lines.join('\n');
}

/** Test seam. */
export function clearLog(): void {
  log.length = 0;
}

export function getLog(): readonly LogEntry[] {
  return log;
}
