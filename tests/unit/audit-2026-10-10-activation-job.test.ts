/**
 * AUDIT-2026-10-10 (fix agent C1):
 *
 *  • H3 — the save picker is opened only with a fresh user gesture: when the
 *    click that started a long export has expired, the user is asked for a
 *    new one (and the picker opened inside it); a refusal the heuristic
 *    missed is caught and asked once more; the job is never re-run.
 *  • M1 — unmounting a panel aborts its job but keeps the app-wide job slot
 *    held until the task has actually settled.
 */
import { describe, expect, it, vi } from 'vitest';

// `useJob` is a hook; this exercises its lifecycle without a DOM by giving it
// the three hooks it uses, with the unmount cleanup captured.
const effects: (() => (() => void) | void)[] = [];
vi.mock('preact/hooks', () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useCallback: <T>(fn: T) => fn,
  useEffect: (fn: () => (() => void) | void) => {
    effects.push(fn);
  }
}));

const { ACTIVATION_WINDOW_MS, isActivationRefusal, needsFreshActivation, withUserActivation } =
  await import('../../src/platform/user-activation');
const { useJob } = await import('../../src/ui/useJob');
const { activeJob } = await import('../../src/core/notify');

describe('H3 — when a fresh gesture is needed', () => {
  it("trusts the browser's own answer when it has one", () => {
    expect(needsFreshActivation({ isActive: false }, Date.now(), Date.now())).toBe(true);
    expect(needsFreshActivation({ isActive: true }, 0, 1e12)).toBe(false);
  });

  it('otherwise goes by the time since the last click', () => {
    const now = 100_000;
    expect(needsFreshActivation(undefined, now - ACTIVATION_WINDOW_MS - 1, now)).toBe(true);
    expect(needsFreshActivation(undefined, now - 1000, now)).toBe(false);
    // Nothing seen at all: cannot tell, so try (and catch a refusal).
    expect(needsFreshActivation(undefined, null, now)).toBe(false);
  });

  it('tells a refused picker from a dismissed one', () => {
    expect(isActivationRefusal(new DOMException('x', 'SecurityError'))).toBe(true);
    expect(isActivationRefusal(new DOMException('x', 'NotAllowedError'))).toBe(true);
    expect(isActivationRefusal(new DOMException('x', 'AbortError'))).toBe(false);
  });
});

describe('H3 — withUserActivation', () => {
  it('asks for a click first when the gesture has expired, then opens the picker', async () => {
    const order: string[] = [];
    const result = await withUserActivation(
      'out.pdf',
      async () => {
        order.push('picker');
        return 'handle';
      },
      {
        expired: () => true,
        request: async name => {
          order.push(`asked:${name}`);
          return true;
        }
      }
    );
    expect(result).toBe('handle');
    expect(order).toEqual(['asked:out.pdf', 'picker']);
  });

  it('opens the picker straight away while the gesture is fresh', async () => {
    const request = vi.fn(async () => true);
    const result = await withUserActivation('a.pdf', async () => 'h', {
      expired: () => false,
      request
    });
    expect(result).toBe('h');
    expect(request).not.toHaveBeenCalled();
  });

  it('a refusal the heuristic missed is asked once more, not swallowed', async () => {
    let calls = 0;
    const request = vi.fn(async () => true);
    const result = await withUserActivation(
      'a.pdf',
      async () => {
        calls += 1;
        if (calls === 1) throw new DOMException('no gesture', 'NotAllowedError');
        return 'h';
      },
      { expired: () => false, request }
    );
    expect(result).toBe('h');
    expect(calls).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('declining to save resolves null without opening the picker', async () => {
    const picker = vi.fn(async () => 'h');
    const result = await withUserActivation('a.pdf', picker, {
      expired: () => true,
      request: async () => false
    });
    expect(result).toBeNull();
    expect(picker).not.toHaveBeenCalled();
  });

  it('a dismissed picker is still the caller’s to handle', async () => {
    await expect(
      withUserActivation(
        'a.pdf',
        async () => {
          throw new DOMException('closed', 'AbortError');
        },
        { expired: () => false, request: async () => true }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('M1 — the job slot is held until the task settles', () => {
  it('unmount aborts the job but keeps activeJob set until it finishes', async () => {
    effects.length = 0;
    activeJob.value = null;
    const { run } = useJob();
    let release!: () => void;
    let seenSignal: AbortSignal | undefined;
    let mutatedAfterAbort = false;
    const done = run({ label: 'Blurring', scope: 'test' }, async job => {
      seenSignal = job.signal;
      await new Promise<void>(resolve => (release = resolve));
      // The pattern every content-rewriting job now follows.
      if (job.signal?.aborted) return;
      mutatedAfterAbort = true;
    });
    expect((activeJob.value as { label?: string } | null)?.label).toBe('Blurring');

    // Unmount.
    const cleanup = effects[0]();
    if (typeof cleanup === 'function') cleanup();
    expect(seenSignal?.aborted).toBe(true);
    // Still running: nothing else may start, and undo stays blocked.
    expect(activeJob.value).not.toBeNull();

    release();
    await done;
    expect(activeJob.value).toBeNull();
    expect(mutatedAfterAbort).toBe(false);
  });
});

describe('H3 — folder picker and permission prompts use the same gesture flow', () => {
  it('a folder save asks with the folder wording (name null)', async () => {
    const asked: (string | null)[] = [];
    const dir = await withUserActivation(null, async () => 'dir', {
      expired: () => true,
      request: async name => {
        asked.push(name);
        return true;
      }
    });
    expect(dir).toBe('dir');
    expect(asked).toEqual([null]);
  });

  it('save over original: a permission prompt refused for want of a click is asked again', async () => {
    const { ensureWritePermissionWithActivation } = await import('../../src/platform/file-system');
    let prompts = 0;
    const handle = {
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: async () => {
        prompts += 1;
        if (prompts === 1) throw new DOMException('activation required', 'SecurityError');
        return 'granted' as PermissionState;
      }
    };
    const request = vi.fn(async () => true);
    const ok = await ensureWritePermissionWithActivation(handle, 'contract.pdf', (name, fn) =>
      withUserActivation(name, fn, { expired: () => false, request })
    );
    expect(ok).toBe(true);
    expect(prompts).toBe(2);
    expect(request).toHaveBeenCalledWith('contract.pdf');
  });

  it('already granted: no prompt at all; declined: false', async () => {
    const { ensureWritePermissionWithActivation } = await import('../../src/platform/file-system');
    const request = vi.fn(async () => false);
    const activate = <T>(name: string | null, fn: () => Promise<T>) =>
      withUserActivation(name, fn, { expired: () => true, request });
    const requestPermission = vi.fn(async () => 'granted' as PermissionState);
    expect(
      await ensureWritePermissionWithActivation(
        { queryPermission: async () => 'granted', requestPermission },
        'a.pdf',
        activate
      )
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(
      await ensureWritePermissionWithActivation(
        { queryPermission: async () => 'prompt', requestPermission },
        'a.pdf',
        activate
      )
    ).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
