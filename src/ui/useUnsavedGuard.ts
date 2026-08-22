/**
 * Warns before a reload or close discards unexported changes.
 *
 * DOC-11 added session recovery (`core/session-recovery.ts`), so a reload no
 * longer *silently* loses an in-progress edit the way it once did — but
 * recovery is an offer made on the next launch, not a guarantee: declining it,
 * a cleared browser storage, or exporting and then editing further are all
 * still real ways to lose work a reload interrupts. This warning stays for
 * that gap, not because recovery doesn't exist.
 *
 * The prompt is deliberately tied to `dirty`, so simply opening a document to look at it
 * never nags.
 */
import { useEffect } from 'preact/hooks';
import { documents } from '../core/store';

export function useUnsavedGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!documents.value.some(doc => doc.dirty)) return;
      // Browsers show their own wording; assigning returnValue is what arms it.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
