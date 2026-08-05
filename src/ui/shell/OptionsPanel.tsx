/**
 * The options panel: a frame plus a per-tool body.
 *
 * It used to be a single 499-line component holding nine `useRoute` calls, the
 * import pipeline, blank-page detection, and every tool's controls inline with
 * repeated `style` objects. Each tool now owns its own panel file.
 */

import { useActiveTool } from '../useActiveTool';
import { activeDoc } from '../../core/store';
import { MergePanel } from '../tools/organize/MergePanel';
import { OrganizePanel } from '../tools/organize/OrganizePanel';
import { InsertPanel } from '../tools/organize/InsertPanel';
import { SplitPanel } from '../tools/split/SplitPanel';
import { BlanksPanel } from '../tools/blanks/BlanksPanel';
import { PdfToImagePanel } from '../tools/convert/PdfToImagePanel';
import { ExtractPanel } from '../tools/extract/ExtractPanel';
import { CompressPanel } from '../tools/compress/CompressPanel';
import { CropPanel } from '../tools/crop/CropPanel';
import { WatermarkPanel } from '../tools/watermark/WatermarkPanel';
import { CleanupPanel } from '../tools/cleanup/CleanupPanel';
import { SignPanel } from '../tools/sign/SignPanel';
import { RedactPanel } from '../tools/redact/RedactPanel';
import { MetadataPanel } from '../tools/metadata/MetadataPanel';
import { NormalizePanel } from '../tools/normalize/NormalizePanel';
import { NUpPanel } from '../tools/nup/NUpPanel';
import { ComparePanel } from '../tools/compare/ComparePanel';
import { AnnotatePanel } from '../tools/annotate/AnnotatePanel';
import { BatchPanel } from '../tools/batch/BatchPanel';
import styles from './OptionsPanel.module.css';
import { useTranslation } from '../../core/i18n';

const BODIES: Record<string, () => preact.JSX.Element | null> = {
  merge: MergePanel,
  organize: OrganizePanel,
  insert: InsertPanel,
  split: SplitPanel,
  'remove-blanks': BlanksPanel,
  'pdf-to-img': PdfToImagePanel,
  extract: ExtractPanel,
  compress: CompressPanel,
  crop: CropPanel,
  watermark: WatermarkPanel,
  cleanup: CleanupPanel,
  sign: SignPanel,
  redact: RedactPanel,
  metadata: MetadataPanel,
  normalize: NormalizePanel,
  nup: NUpPanel,
  compare: ComparePanel,
  annotate: AnnotatePanel,
  batch: BatchPanel
};

export function OptionsPanel() {
  const t = useTranslation();
  const tool = useActiveTool();
  if (!tool || !tool.needsOptionsPanel) return null;

  const Body = BODIES[tool.id];
  const hasDocument = activeDoc.value !== null;

  return (
    <aside className={styles.panel} aria-label={`${tool.title} options`}>
      <div className={styles.section}>
        <h2 className={styles.title}>{tool.title}</h2>
        <p className={styles.description}>{tool.summary}</p>
      </div>
      {hasDocument || tool.worksWithoutDocument ? (
        Body && <Body />
      ) : (
        <p className={`${styles.note} ${styles.noteInfo}`}>
          {t('Open a document to use this tool.')}
        </p>
      )}
    </aside>
  );
}

export { styles as panelStyles };
