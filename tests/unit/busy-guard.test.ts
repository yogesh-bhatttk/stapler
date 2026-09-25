/** AUDIT-2026-09-25 M5 — page edits are refused, with a message, while a job runs. */
import { afterEach, describe, expect, it } from 'vitest';
import { activeJob, toasts } from '../../src/core/notify';
import { refuseEditWhileBusy } from '../../src/ui/busy';

afterEach(() => {
  activeJob.value = null;
});

describe('refuseEditWhileBusy', () => {
  it('allows edits when nothing is running', () => {
    expect(refuseEditWhileBusy()).toBe(false);
  });

  it('refuses and explains while a job runs', () => {
    const before = toasts.value.length;
    activeJob.value = { label: 'Redacting', progress: null, cancel: () => {} };
    expect(refuseEditWhileBusy()).toBe(true);
    expect(toasts.value.length).toBe(before + 1);
    expect(toasts.value.at(-1)?.detail).toContain('Redacting');
  });
});

describe('toast cap (UI-17)', () => {
  it('keeps at most MAX_VISIBLE_TOASTS, dropping the oldest non-danger first', async () => {
    const { notify, MAX_VISIBLE_TOASTS } = await import('../../src/core/notify');
    toasts.value = [];
    notify('danger', 'error one');
    for (let i = 0; i < 10; i++) notify('info', `note ${i}`, { timeout: 0 });
    expect(toasts.value.length).toBe(MAX_VISIBLE_TOASTS);
    expect(toasts.value[0].title).toBe('error one');
    expect(toasts.value.at(-1)?.title).toBe('note 9');
    toasts.value = [];
  });
});
