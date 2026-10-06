/**
 * The options panel: a frame plus a per-tool body.
 *
 * It used to be a single 499-line component holding nine `useRoute` calls, the
 * import pipeline, blank-page detection, and every tool's controls inline with
 * repeated `style` objects. Each tool now owns its own panel file.
 */

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { translate } from '../../core/i18n';
import { useActiveTool } from '../useActiveTool';
import { activeDoc } from '../../core/store';
import { OpenDocumentPrompt } from '../components/OpenDocumentPrompt';
import { MergePanel } from '../tools/organize/MergePanel';
import { OrganizePanel } from '../tools/organize/OrganizePanel';
import { InsertPanel } from '../tools/organize/InsertPanel';
import { SplitPanel } from '../tools/split/SplitPanel';
import { BlanksPanel } from '../tools/blanks/BlanksPanel';
import { PdfToImagePanel } from '../tools/convert/PdfToImagePanel';
import { ImagesToPdfPanel } from '../tools/convert/ImagesToPdfPanel';
import { ImageSizePanel } from '../tools/image-size/ImageSizePanel';
import { ExtractPanel } from '../tools/extract/ExtractPanel';
import { ExtractImagesPanel } from '../tools/extract-images/ExtractImagesPanel';
import { CompressPanel } from '../tools/compress/CompressPanel';
import { CropPanel } from '../tools/crop/CropPanel';
import { WatermarkPanel } from '../tools/watermark/WatermarkPanel';
import { OutlinePanel } from '../tools/outline/OutlinePanel';
import { CleanupPanel } from '../tools/cleanup/CleanupPanel';
import { SignPanel } from '../tools/sign/SignPanel';
import { RedactPanel } from '../tools/redact/RedactPanel';
import { MetadataPanel } from '../tools/metadata/MetadataPanel';
import { AccPanel } from '../tools/acc/AccPanel';
import { OcrPanel } from '../tools/ocr/OcrPanel';
import { TableExtractPanel } from '../tools/ocr/TableExtractPanel';
import { NormalizePanel } from '../tools/normalize/NormalizePanel';
import { NUpPanel } from '../tools/nup/NUpPanel';
import { ComparePanel } from '../tools/compare/ComparePanel';
import { AnnotatePanel } from '../tools/annotate/AnnotatePanel';
import { BatchPanel } from '../tools/batch/BatchPanel';
import { MarkdownToPdfPanel } from '../tools/convert/MarkdownToPdfPanel';
import { PdfToWordPanel } from '../tools/convert/PdfToWordPanel';
import { WordToPdfPanel } from '../tools/convert/WordToPdfPanel';
import { PdfToExcelPanel } from '../tools/convert/PdfToExcelPanel';
import { ExcelToPdfPanel } from '../tools/convert/ExcelToPdfPanel';
import { PdfToPptPanel } from '../tools/convert/PdfToPptPanel';
import { PptToPdfPanel } from '../tools/convert/PptToPdfPanel';
import { ContactSheetPanel } from '../tools/contact-sheet/ContactSheetPanel';
import { ShortcutsPanel } from '../tools/shortcuts/ShortcutsPanel';
import { ReadAloudPanel } from '../tools/read-aloud/ReadAloudPanel';
import { ReflowPanel } from '../tools/reflow/ReflowPanel';
import { HistoryPanel } from '../tools/history/HistoryPanel';
import { SideBySidePanel } from '../tools/side-by-side/SideBySidePanel';
import { GrayscalePanel } from '../tools/grayscale/GrayscalePanel';
import { RepairPanel } from '../tools/repair/RepairPanel';
import styles from './OptionsPanel.module.css';
import shellStyles from './AppShell.module.css';

const BODIES: Record<string, () => preact.JSX.Element | null> = {
  merge: MergePanel,
  organize: OrganizePanel,
  insert: InsertPanel,
  split: SplitPanel,
  'remove-blanks': BlanksPanel,
  'pdf-to-img': PdfToImagePanel,
  'images-to-pdf': ImagesToPdfPanel,
  'image-to-size': ImageSizePanel,
  extract: ExtractPanel,
  'extract-img': ExtractImagesPanel,
  compress: CompressPanel,
  crop: CropPanel,
  watermark: WatermarkPanel,
  outline: OutlinePanel,
  cleanup: CleanupPanel,
  sign: SignPanel,
  redact: RedactPanel,
  metadata: MetadataPanel,
  acc: AccPanel,
  ocr: OcrPanel,
  'table-extract': TableExtractPanel,
  normalize: NormalizePanel,
  nup: NUpPanel,
  compare: ComparePanel,
  annotate: AnnotatePanel,
  batch: BatchPanel,
  'md-to-pdf': MarkdownToPdfPanel,
  'pdf-to-word': PdfToWordPanel,
  'word-to-pdf': WordToPdfPanel,
  'pdf-to-excel': PdfToExcelPanel,
  'excel-to-pdf': ExcelToPdfPanel,
  'pdf-to-ppt': PdfToPptPanel,
  'ppt-to-pdf': PptToPdfPanel,
  'contact-sheet': ContactSheetPanel,
  shortcuts: ShortcutsPanel,
  'read-aloud': ReadAloudPanel,
  reflow: ReflowPanel,
  history: HistoryPanel,
  'side-by-side': SideBySidePanel,
  grayscale: GrayscalePanel,
  repair: RepairPanel
};

/** Whether the bottom-sheet form of the panel is folded down to its title row. */
export const optionsSheetCollapsed = signal(false);

/**
 * DS-10 AC: "no overlap between the options sheet and the preview".
 *
 * Below 1100px the panel is an absolutely positioned bottom sheet laid over the
 * lower part of the canvas, ending where the action bar starts — exactly the
 * canvas wrapper's bottom edge. Its height follows its content and the
 * Hide/Show toggle, so it is measured, and the wrapper reserves that much at
 * its bottom: the preview, the page grid and every other canvas view shrink to
 * the space above the sheet, and SinglePageView's own stage observer re-fits
 * the page to it. Folding the sheet gives the space straight back. As the side
 * panel (>= 1100px) it takes its own room in the flex row, so nothing is
 * reserved.
 *
 * An inline style rather than a custom property: every `var()` must be a
 * declared design token (check-invariants), and this is a measurement. No
 * transition — an animated padding would re-render the page every frame.
 */
function useSheetReservation(el: HTMLElement | null) {
  useEffect(() => {
    // The shell's `.main` row holds both the panel and the canvas.
    const wrapper = el?.parentElement?.querySelector<HTMLElement>(`.${shellStyles.canvasWrapper}`);
    if (!el || !wrapper) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const sheet = getComputedStyle(el).position === 'absolute';
      const next = sheet ? `${Math.ceil(el.getBoundingClientRect().height)}px` : '';
      if (wrapper.style.paddingBottom !== next) wrapper.style.paddingBottom = next;
    };
    // One write per frame however many resize ticks arrive (UI-7).
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    // Crossing the breakpoint flips `position` even if the size happens not to change.
    const sheetQuery = window.matchMedia('(max-width: 1100px)');
    sheetQuery.addEventListener('change', schedule);
    return () => {
      observer.disconnect();
      sheetQuery.removeEventListener('change', schedule);
      if (frame) cancelAnimationFrame(frame);
      wrapper.style.paddingBottom = '';
    };
  }, [el]);
}

export function OptionsPanel() {
  const tool = useActiveTool();
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  useSheetReservation(panelEl);
  if (!tool || !tool.needsOptionsPanel) return null;

  const Body = BODIES[tool.id];
  const hasDocument = activeDoc.value !== null;

  const collapsed = optionsSheetCollapsed.value;

  return (
    <aside
      ref={setPanelEl}
      className={`${styles.panel} ${collapsed ? styles.collapsed : ''}`}
      aria-label={translate('{tool} options', { tool: translate(tool.title) })}
    >
      <div className={styles.section}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{translate(tool.title)}</h1>
          {/* Only shown while the panel is a bottom sheet (< 1100px), where it
              covers the lower half of the canvas — and the Crop, Redact and
              Sign overlays drawn there — with no way to get it out of the
              way (AUDIT-2026-09-25 UI-28). */}
          <button
            type="button"
            className={styles.sheetToggle}
            aria-expanded={!collapsed}
            aria-controls="options-panel-body"
            onClick={() => (optionsSheetCollapsed.value = !collapsed)}
          >
            {collapsed ? translate('Show options') : translate('Hide options')}
          </button>
        </div>
        <p className={styles.description}>{translate(tool.summary)}</p>
      </div>
      <div id="options-panel-body" className={styles.body}>
        {hasDocument || tool.worksWithoutDocument ? Body && <Body /> : <OpenDocumentPrompt />}
      </div>
    </aside>
  );
}
