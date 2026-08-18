import { translate } from '../../core/i18n';
/**
 * The application shell: top bar, rail, canvas, options panel, action bar, plus the
 * global overlays (palette, toasts, confirmations, first-run, shortcuts).
 *
 * Global shortcuts live here rather than being split between `app.tsx` and this file
 * as they were, and they now ignore keystrokes typed into a field — previously ⌘Z
 * inside a text stamp undid a document mutation instead of the typing.
 */
import type { ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';

/**
 * `OptionsPanel` statically imports every tool panel (~25 modules and
 * everything they pull in), and `ActionBar` statically imports `commit.ts`
 * (every tool's export/save logic). Both render `null` on the home route —
 * there's no tool selected yet — but a static `import` bundles the code
 * regardless of whether it renders anything, so the plain marketing landing
 * page was shipping ~290KB gzipped of editor code it could never use
 * (DIST-03: this was most of the gap between the measured Lighthouse
 * performance score and the ≥95 target). Lazy-loading defers that cost to
 * the moment a tool is actually selected.
 */
const OptionsPanel = lazy(() => import('./OptionsPanel').then(m => ({ default: m.OptionsPanel })));
const ActionBar = lazy(() => import('./ActionBar').then(m => ({ default: m.ActionBar })));
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ToastRegion } from '../components/Feedback';
import { ShortcutModal } from '../components/ShortcutModal';
import { WelcomeModal } from '../components/WelcomeModal';
import { isCommandPaletteOpen, isShortcutSheetOpen } from '../../core/ui';
import { canRedo, canUndo, redo, undo } from '../../core/history';
import {
  activeDoc,
  selectAllPages,
  insertPages,
  selectedPageKeys,
  addDocument,
  makePageRefs
} from '../../core/store';
import { useLocation } from 'wouter-preact';
import { toolRoute } from '../../core/tools';
import { useImageImportOptions } from '../useImageImportOptions';
import { importFiles } from '../../core/import';
import { platform } from '../../platform/current';
import { notify } from '../../core/notify';
import { readSetting, writeSetting } from '../../core/db';
import {
  eventMatchesRedoShortcut,
  eventMatchesShortcut,
  getEffectiveBinding,
  customShortcuts
} from '../../core/shortcuts';
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
  const [, setLocation] = useLocation();
  const { requestOptions, node } = useImageImportOptions();
  const [showWelcome, setShowWelcome] = useState(false);
  useUnsavedGuard();

  useEffect(() => {
    // Stored in IndexedDB with the rest of the settings, not localStorage, so
    // "never reappears" survives the same clearing rules as everything else.
    void readSetting<boolean>(WELCOME_KEY).then(seen => {
      if (!seen) setShowWelcome(true);
    });
  }, []);

  // Access signal to subscribe to changes
  void customShortcuts.value;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = isTypingTarget(event.target);

      if (eventMatchesShortcut(event, getEffectiveBinding('palette'))) {
        event.preventDefault();
        isCommandPaletteOpen.value = !isCommandPaletteOpen.value;
        return;
      }
      if (typing) return;

      if (eventMatchesShortcut(event, getEffectiveBinding('shortcuts'))) {
        event.preventDefault();
        isShortcutSheetOpen.value = true;
        return;
      }
      if (eventMatchesShortcut(event, getEffectiveBinding('undo'))) {
        event.preventDefault();
        if (canUndo()) undo();
        return;
      }
      if (eventMatchesRedoShortcut(event)) {
        event.preventDefault();
        if (canRedo()) redo();
        return;
      }
      if (eventMatchesShortcut(event, getEffectiveBinding('selectAll'))) {
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
      // Prefer the event payload: it is available for an ordinary OS paste and
      // does not require the async Clipboard permission. Preventing the default
      // also stops a focused browser control from receiving an accidental image
      // paste while we turn it into a page.
      const eventImage = Array.from(event.clipboardData?.items ?? [])
        .find(item => item.type.startsWith('image/'))
        ?.getAsFile();
      const file = eventImage ?? (await platform.readClipboardImage());
      if (!file) {
        notify('warning', translate('No image found on the clipboard.'));
        return;
      }
      event.preventDefault();

      const options = await requestOptions([file]);
      if (!options) return;

      const { imported, failures } = await importFiles([file], undefined, options);
      if (failures.length > 0) {
        notify('danger', failures[0].message);
        return;
      }

      if (imported.length > 0) {
        if (doc) {
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
        } else {
          addDocument({
            id: crypto.randomUUID(),
            name: imported[0].source.name,
            pages: makePageRefs(imported[0].source.id, imported[0].source.pageCount),
            annotations: [],
            dirty: false
          });
          setLocation(toolRoute('organize'));
        }
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
          <Suspense fallback={null}>
            <ActionBar />
          </Suspense>
        </main>
        <Suspense fallback={null}>
          <OptionsPanel />
        </Suspense>
      </div>

      <CommandPalette />
      <ConfirmDialog />
      <ToastRegion />
      {node}
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
