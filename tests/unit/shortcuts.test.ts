import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEffectiveBinding,
  eventMatchesShortcut,
  findConflict,
  setShortcutOverride,
  resetShortcuts,
  formatBinding
} from '../../src/core/shortcuts';

describe('shortcuts module (DS-09)', () => {
  beforeEach(() => {
    resetShortcuts();
  });

  it('returns default binding when no override is set', () => {
    const binding = getEffectiveBinding('palette');
    expect(binding).toEqual({ key: 'k', mod: true });
  });

  function makeKeyEvent(init: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): KeyboardEvent {
    return init as unknown as KeyboardEvent;
  }

  it('matches keyboard event to binding correctly', () => {
    const paletteBinding = getEffectiveBinding('palette');
    const eventMatch = makeKeyEvent({ key: 'k', ctrlKey: true });
    const eventMismatch = makeKeyEvent({ key: 'k' });

    expect(eventMatchesShortcut(eventMatch, paletteBinding)).toBe(true);
    expect(eventMatchesShortcut(eventMismatch, paletteBinding)).toBe(false);
  });

  it('detects conflicts when rebinding to an existing active shortcut', () => {
    // Try to rebind 'shortcuts' (?) to Ctrl+K (which is used by 'palette')
    const conflict = findConflict('shortcuts', { key: 'k', mod: true });
    expect(conflict).not.toBeNull();
    expect(conflict?.id).toBe('palette');

    const result = setShortcutOverride('shortcuts', { key: 'k', mod: true });
    expect(result.success).toBe(false);
    expect(result.conflict?.id).toBe('palette');
  });

  it('treats Delete and Backspace as the same shortcut for conflict detection', () => {
    const result = setShortcutOverride('rotatePage', { key: 'backspace' });
    expect(result.success).toBe(false);
    expect(result.conflict?.id).toBe('deletePage');
  });

  it('rebinds shortcut successfully when no conflict exists', () => {
    // Rebind 'shortcuts' to 'h'
    const result = setShortcutOverride('shortcuts', { key: 'h' });
    expect(result.success).toBe(true);
    expect(getEffectiveBinding('shortcuts')).toEqual({ key: 'h' });

    // Old key ('?') no longer matches
    const oldEvent = makeKeyEvent({ key: '?' });
    expect(eventMatchesShortcut(oldEvent, getEffectiveBinding('shortcuts'))).toBe(false);

    // New key ('h') matches
    const newEvent = makeKeyEvent({ key: 'h' });
    expect(eventMatchesShortcut(newEvent, getEffectiveBinding('shortcuts'))).toBe(true);
  });

  it('resets all custom shortcuts to defaults', () => {
    setShortcutOverride('shortcuts', { key: 'h' });
    expect(getEffectiveBinding('shortcuts')).toEqual({ key: 'h' });

    resetShortcuts();
    expect(getEffectiveBinding('shortcuts')).toEqual({ key: '?' });
  });

  it('formats bindings for display', () => {
    const modK = formatBinding({ key: 'k', mod: true });
    expect(modK).toContain('K');

    const plainR = formatBinding({ key: 'r' });
    expect(plainR).toBe('R');
  });
});
