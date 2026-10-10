/**
 * AUDIT-2026-10-10 — UI / accessibility / i18n fixes (agent D), the parts that
 * are testable without a DOM: the confirmation dialog's answers, the drop
 * zone's accept rules, split's typed numbers, the grid's roving tab stop, the
 * dialog stack, shortcut labels, locale-aware sizes and lists, the tab title,
 * the theme cycle, the language autonyms, the watermark URL sharing and the
 * web twin's boot gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { VNode } from 'preact';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { confirmAction, confirmRequest } from '../../src/core/notify';
import { currentLocale, registerDictionary } from '../../src/core/i18n';
import { setLocale, setLocaleRoot } from '../../src/core/i18n/load';
import { formatBytes, formatBytesUp } from '../../src/core/bytes';
import { SUPPORTED_FORMATS, supportedFormats } from '../../src/core/import';
import {
  ariaKeyShortcuts,
  customShortcuts,
  formatBinding,
  getEffectiveBinding,
  resetShortcuts,
  setShortcutOverride,
  shortcutLabel
} from '../../src/core/shortcuts';
import { TOOLS, findTool } from '../../src/core/tools';
import { REQUIRED_APIS } from '../../scripts/browser-floors.mjs';

const { ConfirmDialog } = await import('../../src/ui/components/ConfirmDialog');
const { Modal, isModalOpen, registerModal } = await import('../../src/ui/components/Modal');
const { classifyDragItems, isOpenableFile } = await import('../../src/ui/components/dropAccept');
const { everyNError, targetSizeKbError, splitSettingsError, parseTypedNumber } =
  await import('../../src/ui/tools/split/validate');
const { rovingTabStop } = await import('../../src/ui/shell/PageGrid');
const { fieldAccessibleName } = await import('../../src/ui/tools/sign/AcroFormOverlay');
const { acquireWatermarkUrl, releaseWatermarkUrl } =
  await import('../../src/ui/tools/watermark/WatermarkOverlay');
const { documentTitleFor, keepInitialTitleFor } = await import('../../src/ui/documentTitle');
const { nextThemePreference } = await import('../../src/ui/theme');
const { LOCALE_AUTONYMS } = await import('../../src/ui/localeNames');
const { REQUIRED_BUILT_INS, isFramed, missingBuiltIns } = await import('../../src/ui/bootGuard');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const { TOOLS_WITH_EXPORT_REVIEW } = await import('../../src/ui/tools/commit');
const { locales } = await import('../../src/core/i18n');

/** Every vnode in a tree, depth first (props.children and props.footer). */
type AnyVNode = VNode<Record<string, unknown>>;

function walk(node: unknown, out: AnyVNode[] = []): AnyVNode[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const vnode = node as AnyVNode;
  out.push(vnode);
  walk(vnode.props.children, out);
  walk(vnode.props.footer, out);
  return out;
}

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');

afterEach(() => {
  confirmRequest.value = null;
  currentLocale.value = 'en';
  vi.unstubAllGlobals();
});

describe('UI2 — a confirmation whose "no" acts cannot be dismissed', () => {
  it('ordinary confirmations stay dismissible and focus the non-destructive answer', async () => {
    const answer = confirmAction({ title: 'Delete?', body: 'Gone for good.', tone: 'danger' });
    const request = confirmRequest.value!;
    expect(request.dismissible).toBe(true);
    expect(request.initialFocus).toBe('cancel');

    const modal = ConfirmDialog({}) as VNode<Record<string, unknown>>;
    expect(modal.type).toBe(Modal);
    expect(modal.props.dismissible).toBe(true);
    const buttons = walk(modal).filter(v => typeof v.props.onClick === 'function');
    const autofocused = buttons.filter(v => v.props['data-autofocus'] !== undefined);
    expect(autofocused).toHaveLength(1);
    expect(autofocused[0].props.variant).toBe('tertiary'); // Cancel, not the danger button

    // Escape / the scrim answer "no" for an ordinary confirmation.
    (modal.props.onClose as () => void)();
    await expect(answer).resolves.toBe(false);
  });

  it('the session-restore style prompt ignores Escape/scrim and focuses Restore', async () => {
    let settled: boolean | null = null;
    const answer = confirmAction({
      title: 'Restore your previous session?',
      body: '…',
      confirmLabel: 'Restore',
      cancelLabel: 'Start fresh',
      dismissible: false,
      initialFocus: 'confirm'
    }).then(ok => (settled = ok));

    const modal = ConfirmDialog({}) as VNode<Record<string, unknown>>;
    // Modal hides its close button and ignores Escape and the scrim when
    // `dismissible` is false.
    expect(modal.props.dismissible).toBe(false);
    (modal.props.onClose as () => void)();
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(confirmRequest.value).not.toBeNull();

    const buttons = walk(modal).filter(v => typeof v.props.onClick === 'function');
    const restore = buttons.find(v => v.props['data-autofocus'] !== undefined)!;
    expect(walk(restore.props.children).length === 0 ? restore.props.children : null).toBe(
      'Restore'
    );
    (restore.props.onClick as () => void)();
    await answer;
    expect(settled).toBe(true);
  });

  it('the shell raises the restore prompt as non-dismissible', () => {
    const shell = read('src/ui/shell/AppShell.tsx');
    const prompt = shell.slice(shell.indexOf("translate('Restore your previous session?')"));
    expect(prompt.slice(0, 600)).toMatch(/dismissible: false,\s*initialFocus: 'confirm'/);
  });

  it('Modal prefers a [data-autofocus] control over the header close button', () => {
    expect(read('src/ui/components/Modal.tsx')).toMatch(
      /\(preferred \?\? first \?\? dialog\)\?\.focus\(\)/
    );
  });
});

describe('UI4 — view-only tools have no primary action', () => {
  it('flags exactly the six tools whose commit was a no-op', () => {
    const viewOnly = TOOLS.filter(tool => tool.viewOnly).map(tool => tool.id);
    expect(viewOnly.sort()).toEqual(
      ['compare', 'history', 'read-aloud', 'reflow', 'shortcuts', 'side-by-side'].sort()
    );
    for (const id of viewOnly) expect(TOOLS_WITH_EXPORT_REVIEW.has(id)).toBe(false);
  });
});

describe('UI6 — split numbers are stored as typed and validated', () => {
  it('empty, fractional and zero values are errors, not clamped', () => {
    expect(parseTypedNumber('')).toBeNaN();
    expect(everyNError(parseTypedNumber(''))).toBeTruthy();
    expect(everyNError(2.5)).toBeTruthy();
    expect(everyNError(0)).toBeTruthy();
    expect(everyNError(3)).toBeNull();
    // More than the page count is legal: it just yields one file.
    expect(everyNError(500)).toBeNull();
    expect(targetSizeKbError(NaN)).toBeTruthy();
    expect(targetSizeKbError(0.5)).toBeTruthy();
    expect(targetSizeKbError(2.5)).toBeNull();
  });

  it('only the active mode’s field blocks the split', () => {
    const base = {
      mode: 'every_n' as const,
      everyN: NaN,
      customBoundaries: '',
      outputFormat: 'zip' as const,
      targetSizeKb: NaN
    };
    expect(splitSettingsError(base)).toBeTruthy();
    expect(splitSettingsError({ ...base, mode: 'size' })).toBeTruthy();
    expect(splitSettingsError({ ...base, mode: 'individual' })).toBeNull();
  });
});

describe('UI7 — drag items with no MIME type', () => {
  it('an empty-type file (HEIC on macOS) is a maybe while dragging', () => {
    expect(classifyDragItems([{ kind: 'file', type: '' }])).toBe('maybe');
    expect(classifyDragItems([{ kind: 'file', type: 'image/heic' }])).toBe('accept');
    expect(classifyDragItems([{ kind: 'file', type: 'application/pdf' }])).toBe('accept');
    expect(classifyDragItems([{ kind: 'file', type: 'text/plain' }])).toBe('reject');
    expect(classifyDragItems([{ kind: 'string', type: '' }])).toBe('reject');
  });

  it('the drop checks names: HEIC with no type opens, a .txt does not', () => {
    expect(isOpenableFile(new File([new Uint8Array(4)], 'IMG_0001.HEIC', { type: '' }))).toBe(true);
    expect(isOpenableFile(new File([new Uint8Array(4)], 'scan.pdf', { type: '' }))).toBe(true);
    expect(isOpenableFile(new File([new Uint8Array(4)], 'notes.txt', { type: '' }))).toBe(false);
  });

  it('UI8 — the drop zone ring follows keyboard focus on its hidden input', () => {
    const css = read('src/ui/components/DropZone.module.css');
    expect(css).toContain('.dropzone:focus-within');
    expect(css).toContain(':not(:has(:focus-visible))');
    expect(css).not.toMatch(/\.dropzone:focus-visible\s*\{/);
  });
});

describe('UI9 — on-page form controls have accessible names', () => {
  it('prefers the /TU tooltip, falls back to the field name', async () => {
    expect(fieldAccessibleName({ name: 'txt_1', tooltip: 'Surname' })).toBe('Surname');
    expect(fieldAccessibleName({ name: 'txt_1', tooltip: '  ' })).toBe('txt_1');
    expect(fieldAccessibleName({ name: 'txt_1' })).toBe('txt_1');

    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const named = form.createTextField('txt_1');
    named.addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    named.acroField.dict.set(PDFName.of('TU'), PDFString.of('Surname'));
    const box = form.createCheckBox('cb_1');
    box.addToPage(page, { x: 10, y: 50, width: 20, height: 20 });
    box.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Agree to terms'));
    const bare = form.createTextField('txt_2');
    bare.addToPage(page, { x: 10, y: 90, width: 100, height: 20 });
    const bytes = await doc.save();

    const { fields } = await processWorkerImpl.getFormFields(bytes);
    const byName = Object.fromEntries(fields.map(f => [f.name, f]));
    expect(byName.txt_1.tooltip).toBe('Surname');
    expect(byName.cb_1.tooltip).toBe('Agree to terms');
    expect(byName.txt_2.tooltip).toBeUndefined();
    expect(fieldAccessibleName(byName.txt_2)).toBe('txt_2');
  });

  it('table cells are labelled by row and column', () => {
    expect(read('src/ui/tools/ocr/TableExtractPanel.tsx')).toMatch(
      /aria-label=\{t\('Row \{row\}, column \{column\}'/
    );
  });
});

describe('UI10 — the grid always has a tab stop', () => {
  it('is the focused tile while mounted, else the first mounted tile', () => {
    expect(rovingTabStop(5, 0, 12)).toBe(5);
    // Focused tile 5 scrolled away; tiles 24..35 mounted.
    expect(rovingTabStop(5, 24, 12)).toBe(24);
    expect(rovingTabStop(40, 24, 12)).toBe(24);
    expect(rovingTabStop(35, 24, 12)).toBe(35);
    expect(rovingTabStop(3, 0, 0)).toBe(3);
  });

  it('the unused withReorderTransaction helper is gone', () => {
    expect(read('src/ui/shell/PageGrid.tsx')).not.toContain('withReorderTransaction');
  });
});

describe('UI11/UI13 — the palette joins the dialog stack', () => {
  it('registerModal opens the stack, tracks the top entry, and releases', () => {
    expect(isModalOpen()).toBe(false);
    const palette = registerModal();
    expect(isModalOpen()).toBe(true);
    expect(palette.isTop()).toBe(true);
    const confirm = registerModal();
    expect(palette.isTop()).toBe(false);
    expect(confirm.isTop()).toBe(true);
    confirm.release();
    expect(palette.isTop()).toBe(true);
    palette.release();
    expect(isModalOpen()).toBe(false);
  });

  it('the paste handler stands down behind a dialog, like keydown does', () => {
    const shell = read('src/ui/shell/AppShell.tsx');
    const paste = shell.slice(shell.indexOf('const pasteImage = async'));
    expect(paste.slice(0, 400)).toContain('if (isModalOpen()) return;');
  });
});

describe('UI14 — landing pages scope lang/dir to the app', () => {
  it('setLocale writes lang/dir on the locale root, not <html>', async () => {
    const html = { lang: 'en', dir: 'ltr' };
    const appRoot = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement: html });
    registerDictionary('ar', {});
    setLocaleRoot(appRoot as unknown as HTMLElement);
    try {
      await setLocale('ar');
      expect(appRoot).toEqual({ lang: 'ar', dir: 'rtl' });
      expect(html).toEqual({ lang: 'en', dir: 'ltr' });
    } finally {
      setLocaleRoot(null);
    }
    await setLocale('en');
    expect(html).toEqual({ lang: 'en', dir: 'ltr' });
  });
});

describe('UI15 — one object URL per watermark image', () => {
  it('is shared by every tile and revoked when the last one lets go', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:wm-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const urls = Array.from({ length: 40 }, () => acquireWatermarkUrl(bytes, 'png'));
    expect(new Set(urls)).toEqual(new Set(['blob:wm-1']));
    expect(create).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 39; i++) releaseWatermarkUrl(bytes, 'png');
    expect(revoke).not.toHaveBeenCalled();
    releaseWatermarkUrl(bytes, 'png');
    expect(revoke).toHaveBeenCalledWith('blob:wm-1');

    // A replaced image gets its own URL.
    acquireWatermarkUrl(new Uint8Array([1]), 'jpeg');
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('UI19 — shortcut hints follow the binding and the platform', () => {
  beforeEach(() => resetShortcuts());

  it('Ctrl on Windows/Linux, ⌘ on Apple, and remaps show up', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(shortcutLabel('palette')).toBe('Ctrl K');
    expect(shortcutLabel('undo')).toBe('Ctrl Z');
    expect(shortcutLabel('redo')).toBe('Ctrl Y');
    expect(ariaKeyShortcuts(getEffectiveBinding('palette'))).toBe('Control+K');

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
    expect(shortcutLabel('palette')).toBe('⌘K');
    expect(shortcutLabel('redo')).toBe(formatBinding({ key: 'z', mod: true, shift: true }));
    expect(ariaKeyShortcuts(getEffectiveBinding('palette'))).toBe('Meta+K');

    expect(setShortcutOverride('palette', { key: 'j', mod: true, shift: true }).success).toBe(true);
    expect(customShortcuts.value.palette).toBeDefined();
    expect(shortcutLabel('palette')).toBe('⌘⇧J');
  });

  it('no hard-coded ⌘ chord remains in the hints UI19 names', () => {
    expect(read('src/ui/shell/Canvas.tsx')).not.toMatch(/⌘[KZ]/);
    expect(read('src/ui/components/CommandPalette.tsx')).not.toMatch(/hint: '[⇧⌘]/);
    expect(read('src/ui/shell/TopBar.tsx')).not.toContain("'⌘K'");
  });
});

describe('UI20 — counts go through tPlural', () => {
  /**
   * `t`/`translate` with a `{count}` key is a count string a language with
   * several plural forms gets wrong. Allowed only for label-style strings whose
   * translations put the number after a colon or in brackets, so no form
   * depends on it.
   */
  const LABEL_STYLE = new Set([
    '{count}p',
    'Export {count} as a list',
    'Marks ({count})',
    'Attempts: {count}.',
    '{count} selected',
    'regions: {count}',
    'failed: {count}',
    'Stored files that could not be deleted: {count}. Close every other Stapler tab and try again, or use your browser’s “Clear site data”.'
  ]);

  it('no other t()/translate() key interpolates {count}', () => {
    const offenders: string[] = [];
    const walkDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          for (const match of text.matchAll(/\b(?:t|translate)\(\s*'([^']*\{count\}[^']*)'/g)) {
            if (!LABEL_STYLE.has(match[1])) offenders.push(`${full}: ${match[1]}`);
          }
        }
      }
    };
    walkDir(path.resolve(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('UI21 — sizes and format lists follow the app locale', () => {
  it('English output is unchanged', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytesUp(200_001)).toBe('201 KB');
    expect(supportedFormats()).toBe(SUPPORTED_FORMATS);
  });

  it('German uses a decimal comma and its own conjunction', () => {
    currentLocale.value = 'de';
    expect(formatBytes(1_500_000)).toBe('1,5 MB');
    expect(formatBytes(1_234_567)).toBe('1,23 MB');
    expect(formatBytes(200_000)).toBe('200 KB');
    expect(formatBytesUp(1_500_001)).toBe('1,51 MB');
    expect(supportedFormats()).toBe('PDF, PNG, JPEG, WebP, GIF, TIFF und HEIC');
    expect(supportedFormats()).not.toContain(' and ');
  });

  it('Arabic keeps Latin digits like the rest of the app', () => {
    currentLocale.value = 'ar';
    expect(formatBytes(1_500_000)).toMatch(/^1.5 MB$/);
  });
});

describe('UI24 — the tab title follows the route', () => {
  it('names the tool, translated; other routes keep the page title', () => {
    const initial = 'Stapler — Offline PDF Tools';
    expect(documentTitleFor('/tool/compress', initial)).toBe('Compress — Stapler');
    expect(documentTitleFor('/tool/compress?target=100KB', initial)).toBe('Compress — Stapler');
    expect(documentTitleFor('/', initial)).toBe(initial);
    expect(documentTitleFor('/tool/nope', initial)).toBe(initial);

    registerDictionary('de', { Compress: 'Komprimieren' });
    currentLocale.value = 'de';
    expect(documentTitleFor('/tool/compress', initial)).toBe('Komprimieren — Stapler');
  });

  it('a landing page keeps its own static title on its tool', () => {
    keepInitialTitleFor('merge');
    expect(documentTitleFor('/tool/merge', 'Merge PDF files — Stapler')).toBe(
      'Merge PDF files — Stapler'
    );
    expect(documentTitleFor('/tool/split', 'Merge PDF files — Stapler')).toBe(
      `${findTool('split')!.title} — Stapler`
    );
  });
});

describe('UI25 — the theme button reaches system again', () => {
  it('cycles through all three preferences from either OS theme', () => {
    for (const os of ['light', 'dark'] as const) {
      const seen = new Set<string>();
      let pref: 'light' | 'dark' | 'system' = 'system';
      for (let i = 0; i < 3; i++) {
        pref = nextThemePreference(pref, os);
        seen.add(pref);
      }
      expect(seen).toEqual(new Set(['light', 'dark', 'system']));
      expect(pref).toBe('system');
    }
    // The first click always changes what is on screen.
    expect(nextThemePreference('system', 'light')).toBe('dark');
    expect(nextThemePreference('system', 'dark')).toBe('light');
  });
});

describe('UI28 — the language picker shows autonyms', () => {
  it('names every locale in its own language', () => {
    for (const locale of locales) {
      expect(LOCALE_AUTONYMS[locale]).toBeTruthy();
      expect(LOCALE_AUTONYMS[locale].toLowerCase()).not.toBe(locale.toLowerCase());
    }
    expect(LOCALE_AUTONYMS['pt-BR']).toBe('Português (Brasil)');
    expect(LOCALE_AUTONYMS.ar).toBe('العربية');
  });
});

describe('S-info / QA-floor — the web twin’s boot gate', () => {
  it('detects a frame, including a cross-origin one whose top throws', () => {
    const self = {} as Window;
    expect(isFramed({ self, top: self } as Pick<Window, 'top' | 'self'>)).toBe(false);
    expect(isFramed({ self, top: {} as Window } as Pick<Window, 'top' | 'self'>)).toBe(true);
    const crossOrigin = {
      self,
      get top(): Window | null {
        throw new DOMException('Blocked a frame', 'SecurityError');
      }
    };
    expect(isFramed(crossOrigin as unknown as Pick<Window, 'top' | 'self'>)).toBe(true);
  });

  it('names every missing pdf.js built-in, and none on a current engine', () => {
    const modern = {
      Math: { sumPrecise: () => 0 },
      Map: { prototype: { getOrInsertComputed: () => 0 } },
      Uint8Array: { fromBase64: () => 0 },
      Promise: { try: () => 0, withResolvers: () => 0 },
      URL: { parse: () => 0 }
    } as unknown as typeof globalThis;
    expect(missingBuiltIns(modern)).toEqual([]);
    const old = {
      Math: {},
      Map: { prototype: {} },
      Uint8Array: {},
      Promise: { withResolvers: () => 0 },
      URL: { parse: () => 0 }
    } as unknown as typeof globalThis;
    expect(missingBuiltIns(old)).toEqual([
      'Math.sumPrecise',
      'Map.prototype.getOrInsertComputed',
      'Uint8Array.fromBase64',
      'Promise.try'
    ]);
  });

  it('checks exactly the built-ins scripts/browser-floors.mjs lists', () => {
    const fromFloors = REQUIRED_APIS.filter(entry => entry.needle !== '').map(entry => entry.api);
    expect(REQUIRED_BUILT_INS.map(entry => entry.api).sort()).toEqual([...fromFloors].sort());
  });
});

describe('UI22/UI23/UI27 — source-level guards for DOM-only fixes (e2e in audit-2026-10-10-ui.spec.ts)', () => {
  it('UI22 — reading-direction icons mirror under RTL', () => {
    const css = read('src/ui/styles/tokens.css');
    expect(css).toMatch(
      /\[dir='rtl'\]\s*:is\([^)]*\.lucide-chevron-left[^)]*\)\s*\{\s*transform: scaleX\(-1\)/
    );
  });

  it('UI23 — pager buttons use aria-disabled, so they keep focus at the ends', () => {
    for (const file of [
      'src/ui/shell/SinglePageView.tsx',
      'src/ui/components/ExportReviewModal.tsx'
    ]) {
      const text = read(file);
      expect(text).not.toMatch(
        /disabled=\{pageIndex === 0\}|disabled=\{!canPrev\}|disabled=\{!canNext\}/
      );
      expect(text).toContain('aria-disabled=');
    }
    expect(read('src/ui/components/Button.module.css')).toContain(".button[aria-disabled='true']");
  });

  it('UI27 — a cancelled corner drag removes its listeners', () => {
    const text = read('src/ui/tools/cleanup/CleanupEditor.tsx');
    expect(text).toContain("window.addEventListener('pointercancel', end)");
    expect(text).toContain("window.removeEventListener('pointercancel', end)");
  });
});

describe('addendum — batch note headings, tooltip locale, remaining ⌘Z hints', () => {
  it('each batch note kind is listed under its own heading', async () => {
    const { groupBatchNotes } = await import('../../src/ui/tools/batch/noteGroups');
    const groups = groupBatchNotes([
      { file: 'a.pdf', kind: 'kept-original', detail: 'no smaller' },
      { file: 'b.pdf', kind: 'changed', detail: 'a link was left out' },
      { file: 'c.pdf', kind: 'metadata-scrubbed', detail: 'Removed 3 metadata findings.' },
      { file: 'd.pdf', kind: 'failed', detail: 'damaged' },
      { file: 'e.pdf', kind: 'renamed', detail: 'Saved as e (1).pdf' },
      { file: 'f.pdf', kind: 'changed', detail: 'an annotation fell outside the crop' }
    ]);
    expect(groups.map(g => g.kind)).toEqual([
      'failed',
      'kept-original',
      'changed',
      'metadata-scrubbed',
      'renamed'
    ]);
    const unchanged = groups.find(g => g.heading === 'Files written unchanged')!;
    expect(unchanged.notes.map(n => n.file)).toEqual(['a.pdf']);
    expect(groups.find(g => g.kind === 'changed')!.notes.map(n => n.file)).toEqual([
      'b.pdf',
      'f.pdf'
    ]);
    expect(new Set(groups.map(g => g.heading)).size).toBe(groups.length);
    expect(groupBatchNotes([])).toEqual([]);
  });

  it('the tooltip layer carries the app locale’s lang and dir', async () => {
    const { FloatingLayer } = await import('../../src/ui/components/FloatingTooltip');
    currentLocale.value = 'ar';
    const layer = FloatingLayer() as AnyVNode;
    expect(layer.props.lang).toBe('ar');
    expect(layer.props.dir).toBe('rtl');
    currentLocale.value = 'en';
    expect((FloatingLayer() as AnyVNode).props.dir).toBe('ltr');
  });

  it('no hard-coded undo chord remains in the delete, discard and duplex messages', () => {
    for (const file of [
      'src/ui/tools/commit.ts',
      'src/ui/discardAllChanges.ts',
      'src/ui/tools/organize/DuplexSection.tsx'
    ]) {
      const text = read(file);
      expect(text, file).not.toMatch(/with (⌘Z|Ctrl\+Z)/);
      expect(text, file).toContain("shortcutLabel('undo')");
    }
  });
});
