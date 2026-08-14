/**
 * The application shell: top bar, rail, canvas, options panel, action bar, plus the
 * global overlays (palette, toasts, confirmations, first-run, shortcuts).
 *
 * Global shortcuts live here rather than being split between `app.tsx` and this file
 * as they were, and they now ignore keystrokes typed into a field — previously ⌘Z
 * inside a text stamp undid a document mutation instead of the typing.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';
import { OptionsPanel } from './OptionsPanel';
import { ActionBar } from './ActionBar';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ToastRegion } from '../components/Feedback';
import { ShortcutModal } from '../components/ShortcutModal';
import { WelcomeModal } from '../components/WelcomeModal';
import { isCommandPaletteOpen, isShortcutSheetOpen } from '../../core/ui';
import { canRedo, canUndo, redo, undo } from '../../core/history';
import { activeDoc, selectAllPages, insertPages, selectedPageKeys } from '../../core/store';
import { importFiles } from '../../core/import';
import { platform } from '../../platform/current';
import { notify } from '../../core/notify';
import { readSetting, writeSetting } from '../../core/db';
import { useUnsavedGuard } from '../useUnsavedGuard';
import styles from './AppShell.module.css';

const WELCOME_KEY = 'welcomed';

/** True when the keystroke belongs to whatever the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function AppShell({ children }: { children: ComponentChildren }) {
  const [showWelcome, setShowWelcome] = useState(false);
  useUnsavedGuard();

  useEffect(() => {
    // Stored in IndexedDB with the rest of the settings, not localStorage, so
    // "never reappears" survives the same clearing rules as everything else.
    void readSetting<boolean>(WELCOME_KEY).then(seen => {
      if (!seen) setShowWelcome(true);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const typing = isTypingTarget(event.target);

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        isCommandPaletteOpen.value = !isCommandPaletteOpen.value;
        return;
      }
      if (typing) return;

      if (event.key === '?') {
        event.preventDefault();
        isShortcutSheetOpen.value = true;
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          if (canRedo()) redo();
        } else if (canUndo()) {
          undo();
        }
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        if (canRedo()) redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        const doc = activeDoc.value;
        if (!doc) return;
        event.preventDefault();
        selectAllPages(doc.id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return;

      const doc = activeDoc.value;
      if (!doc) return;

      const file = await platform.readClipboardImage();
      if (!file) {
        notify('warning', 'No image found on the clipboard.');
        return;
      }

      const { imported, failures } = await importFiles([file], undefined, undefined);
      if (failures.length > 0) {
        notify('danger', failures[0].message);
        return;
      }

      if (imported.length > 0) {
        let at = doc.pages.length;
        if (selectedPageKeys.value.size > 0) {
          const indices = Array.from(selectedPageKeys.value)
            .map(k => doc.pages.findIndex(p => p.key === k))
            .filter(i => i >= 0);
          if (indices.length > 0) {
            at = Math.max(...indices) + 1;
          }
        }
        insertPages(doc.id, imported[0].pages, at);
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  return (
    <div className={styles.layout}>
      <TopBar />
      <div className={styles.main}>
        <ToolRail />
        <main className={styles.center}>
          <div className={styles.canvasWrapper}>{children}</div>
          <ActionBar />
        </main>
        <OptionsPanel />
      </div>

      <CommandPalette />
      <ConfirmDialog />
      <ToastRegion />
      {isShortcutSheetOpen.value && (
        <ShortcutModal onClose={() => (isShortcutSheetOpen.value = false)} />
      )}
      {showWelcome && (
        <WelcomeModal
          onClose={() => {
            setShowWelcome(false);
            void writeSetting(WELCOME_KEY, true);
          }}
        />
      )}
    </div>
  );
}
