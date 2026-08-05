/**
 * SGN-01 — the signature library.
 *
 * Signatures are stored as PNG *bytes*, not data URLs. A data URL is 33% larger,
 * has to be parsed back on every export, and made the export path split a string on
 * ',' to recover the payload. Bytes go straight into `embedPng`.
 */
import { signal } from '@preact/signals';
import {
  deleteStoredSignature,
  getStoredSignature,
  listSignatures,
  putSignature,
  type StoredSignature
} from './db';
import { logEvent } from './errors';

export type Signature = StoredSignature;

export const signatures = signal<Signature[]>([]);

/** Object URLs for previewing stored PNGs, revoked when the entry goes away. */
const previewUrls = new Map<string, string>();

// Revoke any remaining preview URLs when the extension page is torn down.
// Individual deletions and saves call forgetPreview() promptly; this handler
// only fires for URLs still alive at tab/window close (Bug 6).
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeunload', () => {
    for (const url of previewUrls.values()) URL.revokeObjectURL(url);
    previewUrls.clear();
  });
}

export function signaturePreviewUrl(signature: Signature): string {
  const existing = previewUrls.get(signature.id);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([signature.png.slice()], { type: 'image/png' }));
  previewUrls.set(signature.id, url);
  return url;
}

function forgetPreview(id: string) {
  const url = previewUrls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  previewUrls.delete(id);
}

export async function loadSignatures(): Promise<void> {
  signatures.value = await listSignatures();
}

export async function saveSignature(
  input: Omit<Signature, 'id' | 'createdAt'> & { id?: string }
): Promise<Signature | null> {
  const signature: Signature = {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    png: input.png,
    width: input.width,
    height: input.height,
    purpose: input.purpose ?? 'signature',
    createdAt: Date.now()
  };
  if (!(await putSignature(signature))) return null;
  forgetPreview(signature.id);
  signatures.value = [signature, ...signatures.value.filter(s => s.id !== signature.id)];
  logEvent('info', 'signatures', `Saved a ${signature.kind} signature`);
  return signature;
}

export async function deleteSignature(id: string): Promise<void> {
  await deleteStoredSignature(id);
  forgetPreview(id);
  signatures.value = signatures.value.filter(s => s.id !== id);
}

/**
 * Reads one signature, preferring the in-memory list. The export path calls this,
 * so it must work even before the Sign panel has ever been opened.
 */
export async function getSignature(id: string): Promise<Signature | null> {
  return signatures.value.find(s => s.id === id) ?? (await getStoredSignature(id));
}
