/**
 * DS-09 — Custom keyboard shortcut remapping.
 *
 * Defines default shortcuts, manages user overrides stored in IndexedDB,
 * provides conflict detection, and formatting utilities.
 */
import { signal } from '@preact/signals';
import { readSetting, writeSetting } from './db';
import { logEvent } from './errors';

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
    label: 'Command palette',
    category: 'Global',
    defaultBinding: { key: 'k', mod: true }
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    category: 'Global',
    defaultBinding: { key: '?' }
  },
  {
    id: 'undo',
    label: 'Undo',
    category: 'Document',
    defaultBinding: { key: 'z', mod: true }
  },
  {
    id: 'redo',
    label: 'Redo',
    category: 'Document',
    defaultBinding: { key: 'y', mod: true }
  },
  {
    id: 'selectAll',
    label: 'Select all pages',
    category: 'Document',
    defaultBinding: { key: 'a', mod: true }
  },
  {
    id: 'rotatePage',
    label: 'Rotate page',
    category: 'Page grid',
    defaultBinding: { key: 'r' }
  },
  {
    id: 'deletePage',
    label: 'Delete page',
    category: 'Page grid',
    defaultBinding: { key: 'delete' }
  }
];

const STORAGE_KEY = 'custom_shortcuts';

export const customShortcuts = signal<Record<string, ShortcutBinding>>({});

// Load from IndexedDB / localStorage fallback on init
if (typeof window !== 'undefined') {
  void readSetting<Record<string, ShortcutBinding>>(STORAGE_KEY)
    .then(saved => {
      if (saved && typeof saved === 'object') {
        customShortcuts.value = saved;
        return;
      }
      // `localStorage.getItem` can throw in Safari private browsing and
      // similar hardened environments — this whole callback has no `.catch`
      // below it purely as a backstop, but this specific call is the one
      // realistic way it would actually be needed.
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) {
        try {
          customShortcuts.value = JSON.parse(local);
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
): { success: boolean; conflict?: ShortcutDefinition } {
  const conflict = findConflict(id, newBinding);
  if (conflict) {
    return { success: false, conflict };
  }

  const next = { ...customShortcuts.value, [id]: newBinding };
  customShortcuts.value = next;
  persistShortcuts(next);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return { success: true };
}

export function resetShortcuts() {
  customShortcuts.value = {};
  persistShortcuts({});
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
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
