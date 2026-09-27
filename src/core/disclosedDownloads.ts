/**
 * Audit 2026-09-25 PLT-16 — the "Offline · 0 requests" chip in the top bar used
 * to be a hardcoded string, so it still said "0 requests" right after the user
 * agreed to the OCR language-model download (the one sanctioned network fetch,
 * CLAUDE.md invariant #1). The download module increments this once per
 * completed, consented, integrity-verified download, and the chip reads it.
 *
 * Session-scoped on purpose: it counts requests *this page* made, which is what
 * the chip claims and what DevTools' Network tab (the chip's own "verify this"
 * instructions) would show.
 */
import { signal } from '@preact/signals';

export const disclosedDownloads = signal(0);

export function recordDisclosedDownload(): void {
  disclosedDownloads.value += 1;
}
