/**
 * DS-09 — Custom keyboard shortcut remapping.
 *
 * Defines default shortcuts, manages user overrides stored in IndexedDB,
 * provides conflict detection, and formatting utilities.
 */
import { signal } from '@preact/signals';
import { readSetting, writeSetting } from './db';
import { logEvent } from './errors';
import { tKey } from './i18n/key';
import { translate } from './i18n';
import { notify } from './notify';

export interface ShortcutBinding {
  key: string; // Normalized lowercase, e.g. 'k', 'z', 'y', 'a', 'r', 'delete', 'backspace', '?'
  mod?: boolean; // Ctrl / Cmd
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDefinition {
  id: string;
  label: string;
  category: 'Global' | 'Document' | 'Page grid';
  defaultBinding: ShortcutBinding;
}

function normalizedShortcutKey(key: string): string {
  const normalized = key.toLowerCase();
  return normalized === 'backspace' ? 'delete' : normalized;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'palette',
    label: tKey('Command palette'),
    category: tKey('Global'),
    defaultBinding: { key: 'k', mod: true }
  },
  {
    id: 'shortcuts',
    label: tKey('Keyboard shortcuts'),
    category: tKey('Global'),
    defaultBinding: { key: '?' }
  },
  {
    id: 'undo',
    label: tKey('Undo'),
    category: tKey('Document'),
    defaultBinding: { key: 'z', mod: true }
  },
  {
    id: 'redo',
    label: tKey('Redo'),
    category: tKey('Document'),
    defaultBinding: { key: 'y', mod: true }
  },
  {
    id: 'selectAll',
    label: tKey('Select all pages'),
    category: tKey('Document'),
    defaultBinding: { key: 'a', mod: true }
  },
  {
    id: 'rotatePage',
    label: tKey('Rotate page'),
    category: tKey('Page grid'),
    defaultBinding: { key: 'r' }
  },
  {
    id: 'deletePage',
    label: tKey('Delete page'),
    category: tKey('Page grid'),
    defaultBinding: { key: 'delete' }
  }
];

const STORAGE_KEY = 'custom_shortcuts';

/** Keys that move focus or activate controls; binding them breaks keyboard use. */
const NAVIGATION_KEYS = new Set([
  'tab',
  'enter',
  ' ',
  'spacebar',
  'escape',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown'
]);

/**
 * Why a binding can't be used, or null if it can (AUDIT-2026-09-25 UI-5).
 *
 * The recorder accepted anything. Binding the palette to Tab — the natural key
 * for leaving the field — took Tab over app-wide (the palette is checked before
 * the typing guard), survived reloads, and left Reset reachable only by mouse.
 * Binding Delete page to ArrowRight made grid navigation delete pages.
 */
export function reservedBindingReason(id: string, binding: ShortcutBinding): string | null {
  const key = binding.key.toLowerCase();
  if (!key) return tKey('No key was pressed.');
  if (key === 'tab') return tKey('Tab moves focus and cannot be used as a shortcut.');
  if (NAVIGATION_KEYS.has(key) && !binding.mod && !binding.alt) {
    return tKey('Arrow, Enter, Space, Escape, Home/End and Page keys are needed for navigation.');
  }
  // The palette answers even while typing in a field, so a plain letter would
  // make that letter untypeable everywhere.
  if (id === 'palette' && !binding.mod && !binding.alt) {
    return tKey('The command palette needs Ctrl/⌘ or Alt, because it works while typing.');
  }
  return null;
}

/** Drops persisted overrides a user recorded before `reservedBindingReason` existed. */
function usableOverrides(saved: unknown): Record<string, ShortcutBinding> {
  if (!saved || typeof saved !== 'object') return {};
  const out: Record<string, ShortcutBinding> = {};
  let dropped = 0;
  for (const [id, binding] of Object.entries(saved as Record<string, ShortcutBinding>)) {
    if (!binding || typeof binding.key !== 'string') continue;
    if (reservedBindingReason(id, binding)) {
      dropped += 1;
      continue;
    }
    out[id] = binding;
  }
  if (dropped > 0) {
    // Said out loud, and the cleaned set saved, rather than a binding the user
    // chose silently vanishing (regression review R-UI-9).
    notify(
      'info',
      translate('Some saved shortcuts were reset because they would block keyboard navigation.'),
      { detail: translate('Set them again under Custom shortcuts.') }
    );
    persistShortcuts(out);
    mirrorToLocalStorage(out);
  }
  return out;
}

/** localStorage throws in Safari private mode and when full; it is only a mirror. */
function mirrorToLocalStorage(value: Record<string, ShortcutBinding> | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (err) {
    logEvent('warn', 'shortcuts', `localStorage mirror failed: ${String(err)}`);
  }
}

export const customShortcuts = signal<Record<string, ShortcutBinding>>({});

// Load from IndexedDB / localStorage fallback on init
if (typeof window !== 'undefined') {
  void readSetting<Record<string, ShortcutBinding>>(STORAGE_KEY)
    .then(saved => {
      if (saved && typeof saved === 'object') {
        customShortcuts.value = usableOverrides(saved);
        return;
      }
      // `localStorage.getItem` can throw in Safari private browsing and
      // similar hardened environments — this whole callback has no `.catch`
      // below it purely as a backstop, but this specific call is the one
      // realistic way it would actually be needed.
      let local: string | null;
      try {
        local = localStorage.getItem(STORAGE_KEY);
      } catch {
        return;
      }
      if (local) {
        try {
          customShortcuts.value = usableOverrides(JSON.parse(local));
        } catch {
          // Ignore invalid JSON
        }
      }
    })
    .catch(err => logEvent('warn', 'shortcuts', `Failed to load custom shortcuts: ${String(err)}`));
}

export function getEffectiveBinding(id: string): ShortcutBinding {
  const custom = customShortcuts.value[id];
  if (custom) return custom;
  const def = SHORTCUT_DEFINITIONS.find(s => s.id === id);
  return def ? def.defaultBinding : { key: '' };
}

export function eventMatchesShortcut(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (!binding || !binding.key) return false;
  const mod = event.metaKey || event.ctrlKey;
  const eventKey = normalizedShortcutKey(event.key);
  const bindingKey = normalizedShortcutKey(binding.key);

  const keyMatches = eventKey === bindingKey;

  if (!keyMatches) return false;
  if (Boolean(binding.mod) !== Boolean(mod)) return false;
  if (Boolean(binding.shift) !== Boolean(event.shiftKey)) return false;
  if (Boolean(binding.alt) !== Boolean(event.altKey)) return false;

  return true;
}

/** macOS convention for redo, unless the user explicitly remapped it. */
export function eventMatchesRedoShortcut(event: KeyboardEvent): boolean {
  if (customShortcuts.value.redo) {
    return eventMatchesShortcut(event, customShortcuts.value.redo);
  }
  return (
    eventMatchesShortcut(event, getEffectiveBinding('redo')) ||
    eventMatchesShortcut(event, { key: 'z', mod: true, shift: true })
  );
}

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    normalizedShortcutKey(a.key) === normalizedShortcutKey(b.key) &&
    Boolean(a.mod) === Boolean(b.mod) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    Boolean(a.alt) === Boolean(b.alt)
  );
}

export function findConflict(id: string, newBinding: ShortcutBinding): ShortcutDefinition | null {
  for (const def of SHORTCUT_DEFINITIONS) {
    if (def.id === id) continue;
    const active = getEffectiveBinding(def.id);
    if (bindingsEqual(active, newBinding)) {
      return def;
    }
  }
  return null;
}

// A bare `void writeSetting(...)` per call gives IndexedDB no guarantee that
// two rapid calls' writes *complete* in the order they were made — a second
// rebind's write finishing before the first's would leave the persisted
// record one rebind behind what's in memory. Chaining every write onto the
// same promise forces them to complete in call order.
let writeChain: Promise<unknown> = Promise.resolve();
function persistShortcuts(next: Record<string, ShortcutBinding>): void {
  writeChain = writeChain
    .then(() => writeSetting(STORAGE_KEY, next))
    .catch(err => logEvent('warn', 'shortcuts', `Failed to persist shortcuts: ${String(err)}`));
}

export function setShortcutOverride(
  id: string,
  newBinding: ShortcutBinding
): { success: boolean; conflict?: ShortcutDefinition; reserved?: string } {
  const reserved = reservedBindingReason(id, newBinding);
  if (reserved) return { success: false, reserved };
  const conflict = findConflict(id, newBinding);
  if (conflict) {
    return { success: false, conflict };
  }

  const next = { ...customShortcuts.value, [id]: newBinding };
  customShortcuts.value = next;
  persistShortcuts(next);
  mirrorToLocalStorage(next);
  return { success: true };
}

export function resetShortcuts() {
  customShortcuts.value = {};
  persistShortcuts({});
  mirrorToLocalStorage(null);
}

export function formatBinding(binding: ShortcutBinding): string {
  if (!binding || !binding.key) return '';
  const isApple = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);
  const modSymbol = isApple ? '⌘' : 'Ctrl';
  const altSymbol = isApple ? '⌥' : 'Alt';
  const shiftSymbol = isApple ? '⇧' : 'Shift';

  const parts: string[] = [];
  if (binding.mod) parts.push(modSymbol);
  if (binding.alt) parts.push(altSymbol);
  if (binding.shift) parts.push(shiftSymbol);

  let keyDisplay = binding.key.toUpperCase();
  if (binding.key === 'delete' || binding.key === 'backspace') keyDisplay = 'Delete';
  if (binding.key === ' ') keyDisplay = 'Space';

  parts.push(keyDisplay);
  return parts.join(isApple ? '' : ' ');
}
