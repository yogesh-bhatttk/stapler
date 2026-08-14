/**
 * RED-06 — password protection, as an export setting.
 *
 * Held apart from any one tool's settings because it is applied by `save()` in
 * the commit pipeline, which every tool's export goes through. Nothing here
 * changes the document in the workspace.
 */
import { signal, effect } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import { DEFAULT_PROTECTION, type ProtectionSettings } from '../../../core/pdf/encrypt';

export interface ProtectionState extends ProtectionSettings {
  enabled: boolean;
  /** Typed twice, because a typo here locks the user out of their own export. */
  confirmPassword: string;
}

export const protection = signal<ProtectionState>({
  ...DEFAULT_PROTECTION,
  enabled: false,
  confirmPassword: ''
});

/**
 * Reset when the active document changes, for the same reason redaction marks
 * are: a setting armed against one document must not silently apply to the next
 * one the user opens. Encrypting a file the user did not mean to encrypt is not
 * recoverable without the password they have already forgotten typing.
 */
effect(() => {
  void activeDocId.value;
  protection.value = { ...DEFAULT_PROTECTION, enabled: false, confirmPassword: '' };
});

/**
 * Why this export must not proceed, or `null` when it may. Returning the reason
 * rather than a boolean lets the caller say what is wrong instead of failing
 * silently on a disabled button the user cannot see.
 */
export function protectionIssue(): string | null {
  const state = protection.value;
  if (!state.enabled) return null;
  if (!state.userPassword) return 'Password protection is on, but no password has been set.';
  if (state.userPassword !== state.confirmPassword) return 'The two passwords do not match.';
  return null;
}

/** True when `save()` should encrypt what it is about to write. */
export function protectionActive(): boolean {
  return protection.value.enabled && protectionIssue() === null;
}
