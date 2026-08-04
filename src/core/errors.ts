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
    title: 'This PDF uses a feature Stapler cannot process.',
    recovery: 'The file is untouched. The details below say which feature and what to do instead.'
  },
  CorruptDocument: {
    title: 'This file is damaged or incomplete.',
    recovery: 'Try re-downloading or re-exporting it. Nothing was written.'
  },
  Encrypted: {
    title: 'This PDF is password-protected.',
    recovery:
      'Stapler cannot decrypt files. Open it in a viewer that has the password, save an ' +
      'unprotected copy, then bring that copy here.'
  },
  OutOfMemory: {
    title: 'This document is too large to process in one pass.',
    recovery: 'Split it into smaller files, or close other documents and try again.'
  },
  UserCancelled: {
    title: 'Cancelled.',
    recovery: 'Nothing was changed.'
  },
  InternalError: {
    title: 'Something went wrong inside Stapler.',
    recovery:
      'Your document was not modified. Copy the diagnostic below if you want to file an issue.'
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
    if (v.isStaplerError && v.kind && v.kind in COPY) {
      return new StaplerError(v.kind, v.message ?? '', v.context ?? {});
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

/**
 * A plain-text diagnostic the user can paste into an issue. Contains the log,
 * the error, and the environment — no file names, no document content.
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
    lines.push(`error: ${err.kind}`, `detail: ${err.message}`);
    const ctx = Object.entries(err.context);
    if (ctx.length) lines.push(`context: ${ctx.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    lines.push('');
  }
  lines.push(`log (${log.length} most recent events):`);
  for (const e of log) {
    lines.push(`  ${new Date(e.at).toISOString()} ${e.level.padEnd(5)} ${e.scope}: ${e.message}`);
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
