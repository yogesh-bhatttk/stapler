import { signal } from '@preact/signals';

// Map of image reference key (e.g. "pageKey:xobjectName") to alt-text
export const altTextMap = signal<Map<string, string>>(new Map());

export function setAltText(key: string, text: string) {
  const map = new Map(altTextMap.value);
  if (!text) {
    map.delete(key);
  } else {
    map.set(key, text);
  }
  altTextMap.value = map;
}

export function clearAltText() {
  altTextMap.value = new Map();
}
