import { tPlural, translate } from '../../core/i18n';
import { MAX_OPEN_DOCUMENTS } from '../../core/workspace-limits';
/**
 * The application shell: top bar, rail, canvas, options panel, action bar, plus the
 * global overlays (palette, toasts, confirmations, first-run, shortcuts).
 *
 * Global shortcuts live here rather than being split between `app.tsx` and this file
 * as they were, and they now ignore keystrokes typed into a field — previously ⌘Z
 * inside a text stamp undid a document mutation instead of the typing.
 */
import { tryToRepairAction } from '../tools/repair/state';
import type { ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
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
import { isModalOpen } from '../components/Modal';
import { refuseEditWhileBusy } from '../busy';
import { OcrConsentDialog } from '../components/OcrConsentDialog';
import { ExportReviewModal } from '../components/ExportReviewModal';
import { ToastRegion } from '../components/Feedback';
import { ShortcutModal } from '../components/ShortcutModal';
import { WelcomeModal } from '../components/WelcomeModal';
import { isCommandPaletteOpen, isShortcutSheetOpen } from '../../core/ui';
import { canRedo, canUndo, redo, undo, historyVersion } from '../../core/history';
import {
  activeDoc,
  selectAllPages,
  insertPages,
  selectedPageKeys,
  documents,
  sources,
  activeDocId
} from '../../core/store';
import {
  runStartupRecovery,
  scheduleSessionSave,
  sessionRecoveryChecked
} from '../../core/session-recovery';
import { useLocation } from 'wouter-preact';
import { toolRoute } from '../../core/tools';
import { useImageImportOptions } from '../useImageImportOptions';
import { useExternalOpen } from '../useExternalOpen';
import { importFiles } from '../../core/import';
import {
  addImportedDocuments,
  discardImported,
  ensureImportsAllowed,
  importFilesAsDocuments,
  runImportJob
} from '../../core/open-document';
import { platform } from '../../platform/current';
import { notify, confirmAction, confirmRequest } from '../../core/notify';
import { readSetting, writeSetting } from '../../core/db';
import {
  eventMatchesRedoShortcut,
  eventMatchesShortcut,
  getEffectiveBinding,
  customShortcuts
} from '../../core/shortcuts';
import { useUnsavedGuard } from '../useUnsavedGuard';
import { FloatingLayer } from '../components/FloatingTooltip';
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
  useExternalOpen(requestOptions); // GAP-2: files opened with / shared to the installed web app
  const [showWelcome, setShowWelcome] = useState(false);
  useUnsavedGuard();

  // GAP-7 — the extension's `pdf` omnibox keyword asks an open editor tab to
  // switch tool. A hash change, like any rail click, so open documents stay.
  useEffect(
    () =>
      platform.onExternalNavigate?.(route => {
        window.location.hash = `#${route}`;
      }),
    []
  );

  useEffect(() => {
    // Stored in IndexedDB with the rest of the settings, not localStorage, so
    // "never reappears" survives the same clearing rules as everything else.
    void readSetting<boolean>(WELCOME_KEY).then(seen => {
      if (!seen) setShowWelcome(true);
    });
  }, []);

  // DOC-11 — offered once, on mount, before the autosave watcher below is
  // allowed to run: reading the record and then immediately arming autosave
  // in the same tick would let the very first (empty, pre-restore) autosave
  // fire and overwrite it before the prompt ever resolves.
  useEffect(() => {
    // RT-23/RT-4/RT-14 — see `runStartupRecovery`: always ends with
    // `sessionRecoveryChecked` true, sweeps orphaned OPFS sources once the
    // decision is made, and flags the prompt so imports refuse under it.
    void runStartupRecovery(({ record, droppedDocuments, droppedOverLimit }) => {
      const count = record.documents.length;
      const found = tPlural(
        'Stapler found {count} documents open from before this tab closed. Restore them exactly as they were, undo history included, or start with a clean workspace.',
        count
      );
      // RT-6: documents left out for the open-document ceiling still exist on
      // disk; only the rest have truly lost their saved data.
      const missing = droppedDocuments - droppedOverLimit;
      const notes = [
        missing > 0
          ? tPlural(
              '{count} other documents from that session could not be recovered — its saved data no longer exists.',
              missing
            )
          : null,
        droppedOverLimit > 0
          ? tPlural(
              '{count} more documents were left out because Stapler opens at most {max} at once. Open them again from disk.',
              droppedOverLimit,
              { max: MAX_OPEN_DOCUMENTS }
            )
          : null
      ].filter(Boolean);
      const body = notes.length > 0 ? `${found} ${notes.join(' ')}` : found;
      return confirmAction({
        title: translate('Restore your previous session?'),
        body,
        confirmLabel: translate('Restore'),
        cancelLabel: translate('Start fresh')
      });
    });
  }, []);

  // DOC-11 — autosaves the lightweight pointer state (never document bytes;
  // see `session-recovery.ts`'s header) on every meaningful change, so a
  // crash or accidental reload has something recent to offer back.
  useSignalEffect(() => {
    if (!sessionRecoveryChecked.value) return;
    void documents.value;
    void sources.value;
    void activeDocId.value;
    void historyVersion.value;
    scheduleSessionSave();
  });

  // Access signal to subscribe to changes
  void customShortcuts.value;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Nothing global acts behind an open dialog: opening the palette over the
      // session-restore prompt and pressing Escape used to answer the prompt
      // too, and Undo or a tool switch could run unseen (AUDIT-2026-09-25 UI-7).
      if (isModalOpen()) return;
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
      if (!(await ensureImportsAllowed())) return;

      const options = await requestOptions([file]);
      if (!options) return;

      // RT-7 — a job like every other open: progress in the action bar, a
      // working Cancel, and edits locked while it runs.
      const outcome = await runImportJob(translate('Adding pasted image'), async job => {
        const result = await importFiles([file], job, options);
        if (job.signal?.aborted) {
          discardImported(result);
          return null;
        }
        return result;
      });
      if (!outcome) return;
      if (outcome.failures.length > 0) {
        const failure = outcome.failures[0];
        notify('danger', failure.message, {
          ...(failure.repairable ? { action: tryToRepairAction(failure.repairable) } : {})
        });
        return;
      }
      const imported = outcome.imported[0];
      if (!imported) return;

      // Looked up again: the document captured when the paste started may
      // have been closed while the image was being imported.
      const target = doc ? documents.value.find(d => d.id === doc.id) : undefined;
      if (target) {
        if (refuseEditWhileBusy()) {
          discardImported(outcome);
          return;
        }
        let at = target.pages.length;
        if (selectedPageKeys.value.size > 0) {
          const indices = Array.from(selectedPageKeys.value)
            .map(k => target.pages.findIndex(p => p.key === k))
            .filter(i => i >= 0);
          if (indices.length > 0) {
            at = Math.max(...indices) + 1;
          }
        }
        insertPages(target.id, imported.pages, at);
      } else {
        // RT-6 — the same add as every other open path: one undo step.
        addImportedDocuments(outcome, [file]);
        setLocation(toolRoute('organize'));
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    // PageGrid's own drag handlers only call preventDefault() for an internal
    // page-reorder drag (when `dragKey` is set). A file dragged in from the OS
    // and dropped anywhere else in the app — the tool rail, the top bar, empty
    // canvas space — never had its default handled, so the browser's default
    // action (navigating the tab to the dropped file) could fire and silently
    // destroy the whole open workspace with no confirmation
    // (AUDIT-EDGE-CASES-2026-09-15 §1.1). Block that globally.
    const isFileDrag = (transfer: DataTransfer | null) =>
      Array.from(transfer?.types ?? []).includes('Files');

    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };

    const onDrop = (event: DragEvent) => {
      // A drop some element already handled (the Home DropZone, a panel's own
      // drop target) has bubbled here. Importing it again opened every dropped
      // PDF as two tabs (AUDIT-2026-09-25 UI-2).
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!isFileDrag(event.dataTransfer)) return; // an internal reorder drag, already handled
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      if (activeDoc.value) {
        // A drop onto a document being edited is ambiguous — a new tab, or
        // pages inserted into this one? Rather than guess, point at the real
        // affordance. (It used to be refused because the open path wiped the
        // undo history; since RT-6 opening is an ordinary undo step.)
        notify('info', translate('Use "Add PDF" to insert pages into this document.'));
        return;
      }

      // Land in Organize, like every other open path (the Home drop zone,
      // Recents, paste) — the new tab used to open behind the Home screen.
      void importFilesAsDocuments(files, { requestImageOptions: requestOptions }).then(
        ({ imported }) => {
          if (imported > 0) setLocation(toolRoute('organize'));
        }
      );
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
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
          <FloatingLayer />
        </main>
        <Suspense fallback={null}>
          <OptionsPanel />
        </Suspense>
      </div>

      <CommandPalette />
      <ConfirmDialog />
      <OcrConsentDialog />
      <ExportReviewModal />
      <ToastRegion />
      {node}
      {isShortcutSheetOpen.value && (
        <ShortcutModal onClose={() => (isShortcutSheetOpen.value = false)} />
      )}
      {/* Waits for any open confirm (a share or session-restore prompt) so the
          two never stack; it shows once that is answered. */}
      {showWelcome && !confirmRequest.value && (
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
