import { beforeEach, describe, expect, it } from 'vitest';
import {
  StaplerError,
  buildDiagnostic,
  cancelled,
  clearLog,
  corrupt,
  encrypted,
  fromUnknown,
  getLog,
  internal,
  isCancellation,
  logError,
  logEvent
} from '../../src/core/errors';

describe('StaplerError', () => {
  it('carries user-facing copy for every kind', () => {
    for (const error of [
      corrupt('x'),
      encrypted('x'),
      cancelled(),
      internal('x'),
      new StaplerError('OutOfMemory', 'x'),
      new StaplerError('UnsupportedFeature', 'x')
    ]) {
      expect(error.copy.title.length).toBeGreaterThan(0);
      expect(error.copy.recovery.length).toBeGreaterThan(0);
    }
  });

  it('never claims a document was modified on an unrecoverable error', () => {
    // PLAN §5.2: on any unrecoverable error we return the original bytes and say so.
    expect(internal('boom').copy.recovery).toMatch(/not modified|untouched|nothing was written/i);
    expect(corrupt('boom').copy.recovery).toMatch(/nothing was written/i);
  });
});

describe('fromUnknown', () => {
  // Comlink structured-clones errors across the worker boundary, which drops the
  // prototype — so `instanceof` cannot be how the kind survives.
  it('rehydrates a kind from a structured-cloned error', () => {
    const original = encrypted('needs a password');
    const cloned = JSON.parse(
      JSON.stringify({
        isStaplerError: true,
        kind: original.kind,
        message: original.message,
        context: original.context
      })
    );
    const restored = fromUnknown(cloned);
    expect(restored).toBeInstanceOf(StaplerError);
    expect(restored.kind).toBe('Encrypted');
    expect(restored.message).toBe('needs a password');
  });

  it('passes a real StaplerError through unchanged', () => {
    const error = corrupt('truncated');
    expect(fromUnknown(error)).toBe(error);
  });

  it('maps an AbortError to a cancellation', () => {
    expect(fromUnknown({ name: 'AbortError', message: 'aborted' }).kind).toBe('UserCancelled');
  });

  it('recognises an allocation failure as OutOfMemory', () => {
    expect(fromUnknown(new RangeError('Array buffer allocation failed')).kind).toBe('OutOfMemory');
    expect(fromUnknown({ message: 'out of memory' }).kind).toBe('OutOfMemory');
  });

  it('falls back to InternalError for anything else', () => {
    expect(fromUnknown(new TypeError('undefined is not a function')).kind).toBe('InternalError');
    expect(fromUnknown('a bare string').kind).toBe('InternalError');
    expect(fromUnknown(undefined).kind).toBe('InternalError');
  });

  it('ignores an unknown kind rather than trusting it', () => {
    expect(fromUnknown({ isStaplerError: true, kind: 'Whatever' }).kind).toBe('InternalError');
  });
});

describe('isCancellation', () => {
  it('recognises cancellation in every shape it can arrive in', () => {
    expect(isCancellation(cancelled())).toBe(true);
    expect(isCancellation({ kind: 'UserCancelled' })).toBe(true);
    expect(isCancellation({ name: 'AbortError' })).toBe(true);
    expect(isCancellation(corrupt('x'))).toBe(false);
    expect(isCancellation('nope')).toBe(false);
    expect(isCancellation(null)).toBe(false);
  });
});

describe('the diagnostic log', () => {
  beforeEach(clearLog);

  it('stays bounded so a long session cannot grow without limit', () => {
    for (let i = 0; i < 500; i++) logEvent('info', 'test', `event ${i}`);
    expect(getLog().length).toBeLessThanOrEqual(200);
    // The most recent events are the ones kept.
    expect(getLog()[getLog().length - 1].message).toBe('event 499');
  });

  it('includes the error and the log in a diagnostic', () => {
    logEvent('warn', 'render', 'page 3 was slow');
    const error = logError('export', corrupt('bad xref'));
    const diagnostic = buildDiagnostic(error);
    expect(diagnostic).toContain('CorruptDocument');
    expect(diagnostic).toContain('bad xref');
    expect(diagnostic).toContain('page 3 was slow');
  });

  it('produces a diagnostic even with no error', () => {
    expect(buildDiagnostic()).toContain('Stapler diagnostic');
  });
});
