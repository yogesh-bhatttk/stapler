/**
 * The options panel: a frame plus a per-tool body.
 *
 * It used to be a single 499-line component holding nine `useRoute` calls, the
 * import pipeline, blank-page detection, and every tool's controls inline with
 * repeated `style` objects. Each tool now owns its own panel file.
 */

import { signal } from '@preact/signals';
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

export function OptionsPanel() {
  const tool = useActiveTool();
  if (!tool || !tool.needsOptionsPanel) return null;

  const Body = BODIES[tool.id];
  const hasDocument = activeDoc.value !== null;

  const collapsed = optionsSheetCollapsed.value;

  return (
    <aside
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
