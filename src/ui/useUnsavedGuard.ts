/**
 * Warns before a reload or close discards unexported changes.
 *
 * The workspace lives in memory only — see the note on session persistence in
 * `core/store.ts` — so a reload genuinely loses edits. That is a defensible trade
 * (persisting whole documents on every keystroke was worse), but it is only defensible
 * if the user is told, rather than finding out afterwards.
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
