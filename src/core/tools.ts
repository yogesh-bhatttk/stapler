/**
 * The tool registry.
 *
 * DESIGN-ADAPTATION §4.2 says tools declare their canvas mode and whether they
 * need an options panel. Previously each of `ActionBar`, `OptionsPanel`, `Canvas`,
 * and `Thumbnail` re-derived that with its own chain of `useRoute` calls — nine in
 * one component — so adding a tool meant editing four files and forgetting one
 * produced a control that did nothing. The rail, the palette, the panel, the canvas,
 * and the action bar all read from this list.
 */

import { signal } from '@preact/signals';
import { tKey } from './i18n/key';

export type ToolId =
  | 'merge'
  | 'organize'
  | 'split'
  | 'insert'
  | 'remove-blanks'
  | 'cleanup'
  | 'pdf-to-img'
  | 'images-to-pdf'
  | 'extract-img'
  | 'extract'
  | 'compress'
  | 'crop'
  | 'watermark'
  | 'outline'
  | 'sign'
  | 'redact'
  | 'metadata'
  | 'normalize'
  | 'nup'
  | 'compare'
  | 'annotate'
  | 'batch'
  | 'md-to-pdf'
  | 'pdf-to-word'
  | 'word-to-pdf'
  | 'pdf-to-excel'
  | 'excel-to-pdf'
  | 'pdf-to-ppt'
  | 'ppt-to-pdf'
  | 'ocr'
  | 'table-extract'
  | 'acc'
  | 'contact-sheet'
  | 'shortcuts'
  | 'read-aloud'
  | 'reflow'
  | 'history'
  | 'side-by-side';

export type ToolGroup = 'Organize' | 'Convert' | 'Optimize' | 'Document' | 'Automation';

/** Grid shows page thumbnails; single shows one page with an overlay layer. */
export type CanvasMode = 'grid' | 'single';

export interface ToolDefinition {
  id: ToolId;
  title: string;
  group: ToolGroup;
  /** Sentence used in the palette and as the panel's description. */
  summary: string;
  /** Lucide icon name, resolved by the UI so core stays free of components. */
  icon: string;
  canvasMode: CanvasMode;
  needsOptionsPanel: boolean;
  /** Label of the action-bar primary button. */
  commitLabel: string;
  /**
   * Whether the grid lets the user tick pages. Tools that operate on a selection
   * (split, remove blanks) need it; merge and organize use direct manipulation.
   */
  selectable: boolean;
  /** False for tools that need a document loaded before they mean anything. */
  worksWithoutDocument?: boolean;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'merge',
    title: tKey('Merge'),
    group: 'Organize',
    summary: tKey('Combine several PDFs and images into one document.'),
    icon: 'Layers',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: false,
    // Merge builds a document from scratch, same as images-to-pdf — it should
    // never require opening one first just to have something to add files to.
    worksWithoutDocument: true
  },
  {
    id: 'organize',
    title: tKey('Organize'),
    group: 'Organize',
    summary: tKey('Rotate, delete, duplicate, and reorder pages.'),
    icon: 'LayoutGrid',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: true
  },
  {
    id: 'split',
    title: tKey('Split & extract'),
    group: 'Organize',
    summary: tKey('Extract a selection, or split into several files.'),
    icon: 'SplitSquareHorizontal',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Split / extract'),
    selectable: true
  },
  {
    id: 'remove-blanks',
    title: tKey('Remove blanks'),
    group: 'Organize',
    summary: tKey('Find blank pages and confirm before removing them.'),
    icon: 'Eraser',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Delete selected'),
    selectable: true
  },
  {
    id: 'nup',
    title: tKey('N-up & Booklet'),
    group: 'Organize',
    summary: tKey('Impose pages into 2-up, 4-up, or booklet layouts.'),
    icon: 'BookOpen',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Export layout'),
    selectable: false
  },
  {
    id: 'cleanup',
    title: tKey('Scan cleanup'),
    group: 'Optimize',
    summary: tKey('Straighten and whiten a photographed or scanned page.'),
    icon: 'Sparkles',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Apply & export'),
    selectable: false
  },
  {
    id: 'compress',
    title: tKey('Compress'),
    group: 'Optimize',
    summary: tKey('Reduce file size, and say honestly when there is nothing to gain.'),
    icon: 'Minimize2',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Compress & export'),
    selectable: false
  },
  {
    id: 'crop',
    title: tKey('Crop'),
    group: 'Organize',
    summary: tKey('Crop margins manually or automatically trim white space.'),
    icon: 'Crop',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: false
  },
  {
    id: 'watermark',
    title: tKey('Watermark'),
    group: 'Organize',
    summary: tKey('Add text watermarks or page numbers.'),
    icon: 'Stamp',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: false
  },
  {
    id: 'outline',
    title: tKey('Bookmarks'),
    group: 'Document',
    summary: tKey('Edit the document outline: rename, add, delete, and reorder bookmarks.'),
    icon: 'ListTree',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: false
  },
  {
    id: 'normalize',
    title: tKey('Normalize'),
    group: 'Organize',
    summary: tKey('Resize documents with mixed page sizes to a uniform standard size.'),
    icon: 'Scaling',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Normalize & export'),
    selectable: false
  },
  {
    id: 'pdf-to-img',
    title: tKey('PDF to images'),
    group: 'Convert',
    summary: tKey('Export pages as PNG or JPEG at a chosen resolution.'),
    icon: 'Image',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Export images'),
    selectable: true
  },
  {
    id: 'images-to-pdf',
    title: tKey('Images to PDF'),
    group: 'Convert',
    summary: tKey('Combine photos and images into one PDF.'),
    icon: 'FileImage',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Export PDF'),
    worksWithoutDocument: true,
    selectable: false
  },
  {
    id: 'extract-img',
    title: tKey('Extract images'),
    group: 'Convert',
    summary: tKey('Pull embedded photos and artwork out at their original quality.'),
    icon: 'ImageDown',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Extract images'),
    selectable: true
  },
  {
    id: 'extract',
    title: tKey('Extract text'),
    group: 'Convert',
    summary: tKey('Pull out plain text or Markdown in reading order.'),
    icon: 'FileText',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    selectable: true
  },
  {
    id: 'sign',
    title: tKey('Sign & fill'),
    group: 'Document',
    summary: tKey('Place a stamped signature, text, dates, and check marks.'),
    icon: 'PenTool',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Export signed PDF'),
    selectable: false
  },
  {
    id: 'redact',
    title: tKey('Redact'),
    group: 'Document',
    summary: tKey('Remove content permanently, then prove it was removed.'),
    icon: 'ShieldAlert',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Verify & apply'),
    selectable: false
  },
  {
    id: 'ocr',
    title: tKey('OCR text layer'),
    group: 'Document',
    summary: tKey('Read the text in a scan and add an invisible, searchable text layer.'),
    icon: 'ScanText',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Run OCR & export'),
    // A scan is often a handful of pages inside a longer document, and OCR is by
    // far the slowest operation here — running it on pages that already have text
    // would cost minutes for nothing.
    selectable: true
  },
  {
    id: 'table-extract',
    title: tKey('Table extraction'),
    group: 'Document',
    summary: tKey('Extract structured tables from PDF page text positions to CSV, TSV, or XLSX.'),
    icon: 'Table',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Export Table'),
    selectable: true
  },
  {
    id: 'metadata',
    title: tKey('Metadata'),
    group: 'Document',
    summary: tKey('See what the file reveals about you, and strip it.'),
    icon: 'FileSearch',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Strip & export'),
    selectable: false
  },
  {
    id: 'acc',
    title: tKey('Alt-text editor'),
    group: 'Document',
    summary: tKey('Attach alt-text to images for PDF/UA accessibility.'),
    icon: 'Accessibility',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Tag & export'),
    selectable: false
  },
  {
    id: 'contact-sheet',
    title: tKey('Contact sheet'),
    group: 'Document',
    summary: tKey('Export a grid of page thumbnails as a single PDF.'),
    icon: 'LayoutGrid',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Export PDF'),
    selectable: false
  },
  {
    id: 'shortcuts',
    title: tKey('Custom shortcuts'),
    group: 'Document',
    summary: tKey('View and customise keyboard shortcuts.'),
    icon: 'Keyboard',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false,
    worksWithoutDocument: true
  },
  {
    id: 'compare',
    title: tKey('Compare'),
    group: 'Document',
    summary: tKey('Compare two PDFs and view visual or text differences.'),
    icon: 'GitPullRequest',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false
  },
  {
    id: 'annotate',
    title: tKey('Annotate'),
    group: 'Document',
    summary: tKey('Draw highlights, shapes, and text notes on the document.'),
    icon: 'PenTool',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Export annotated PDF'),
    selectable: false
  },
  {
    id: 'insert',
    title: tKey('Insert pages'),
    group: 'Organize',
    summary: tKey('Drop pages from another document at a chosen position.'),
    icon: 'FilePlus',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('View changes…'),
    // Selecting a page in the grid sets the insertion anchor — the panel inserts
    // right after the last selected page.
    selectable: true
  },
  {
    id: 'batch',
    title: tKey('Batch process'),
    group: 'Automation',
    summary: tKey('Apply a recipe of operations to a folder of PDFs.'),
    icon: 'FolderOpen',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Run Batch'),
    selectable: false,
    worksWithoutDocument: true
  },
  {
    id: 'md-to-pdf',
    group: 'Convert',
    title: tKey('Markdown to PDF'),
    summary: tKey('Convert a Markdown file or text into a PDF.'),
    icon: 'FileText',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Export PDF'),
    worksWithoutDocument: true,
    selectable: false
  },
  {
    id: 'pdf-to-word',
    group: 'Convert',
    title: tKey('PDF to Word'),
    // The summary is the panel's description and the palette's subtitle, so the
    // fidelity limit PLAN §5.5 requires us to state has to fit in it.
    summary: tKey('Convert to an editable .docx. Text and structure, not exact layout. Beta.'),
    icon: 'FileType',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Save .docx'),
    selectable: false
  },
  {
    id: 'word-to-pdf',
    group: 'Convert',
    title: tKey('Word to PDF'),
    // Same rule as `pdf-to-word` above: the summary is the panel's description
    // and the palette's subtitle, so the fidelity limit PLAN §5.5 requires us to
    // state has to fit inside it.
    summary: tKey('Turn a .docx into a PDF. Content and structure, not Word’s layout. Beta.'),
    icon: 'FilePlus',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Save PDF'),
    // The input is a `.docx` picked from disk, not the open PDF — requiring a
    // document first would mean opening an unrelated PDF to convert a Word file.
    worksWithoutDocument: true,
    selectable: false
  },
  {
    id: 'pdf-to-excel',
    group: 'Convert',
    title: tKey('PDF to Excel'),
    // Same rule as the two above: the summary is the panel's description and the
    // palette's subtitle, so the fidelity limit PLAN §5.5 requires us to state
    // has to fit inside it. "Detected" is the load-bearing word — a PDF has no
    // tables, only text that happens to line up.
    summary: tKey(
      'Pull detected tables into a .xlsx. Cell values, not formulas or formatting. Beta.'
    ),
    icon: 'Table',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Save .xlsx'),
    selectable: false
  },
  {
    id: 'excel-to-pdf',
    group: 'Convert',
    title: tKey('Excel to PDF'),
    // Same rule as the three above: the summary is the panel's description and
    // the palette's subtitle, so the fidelity limit PLAN §5.5 requires us to
    // state has to fit inside it. "Grid" is the load-bearing word — this draws
    // the cells, it does not reproduce Excel's own printed page.
    summary: tKey('Draw each sheet as a paginated grid. Cell values, not Excel’s layout. Beta.'),
    icon: 'Sheet',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Save PDF'),
    // The input is an `.xlsx` picked from disk, not the open PDF — requiring a
    // document first would mean opening an unrelated PDF to convert a workbook.
    worksWithoutDocument: true,
    selectable: false
  },
  {
    id: 'pdf-to-ppt',
    group: 'Convert',
    title: tKey('PDF to PowerPoint'),
    // Same rule as the four above: the summary is the panel's description and
    // the palette's subtitle, so the fidelity limit PLAN §5.5 requires us to
    // state has to fit inside it. This is the widest gap of the six converters,
    // so the summary leads with what the output *is* — boxes and pictures placed
    // where the page drew them — rather than with the word "convert".
    summary: tKey(
      'Place each page’s text and images on a slide. Positioned boxes, not an editable deck. Beta.'
    ),
    icon: 'Presentation',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Save .pptx'),
    selectable: false
  },
  {
    id: 'ppt-to-pdf',
    group: 'Convert',
    title: tKey('PowerPoint to PDF'),
    // Same rule as the five above: the summary is the panel's description and
    // the palette's subtitle, so the fidelity limit PLAN §5.5 requires us to
    // state has to fit inside it. "Where the deck put them" is the load-bearing
    // phrase — this draws each slide's shapes at their own coordinates, and it
    // draws nothing the deck did not store as text, a picture or a table.
    summary: tKey(
      'Draw each slide as its own page, text and pictures where the deck put them. Beta.'
    ),
    icon: 'FilePlus',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Save PDF'),
    // The input is a `.pptx` picked from disk, not the open PDF — requiring a
    // document first would mean opening an unrelated PDF to convert a deck.
    worksWithoutDocument: true,
    selectable: false
  },
  {
    id: 'read-aloud',
    title: tKey('Read aloud'),
    group: 'Document',
    summary: tKey('Read the extracted text aloud, page by page.'),
    icon: 'Volume2',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false
  },
  {
    id: 'reflow',
    title: tKey('Reflow view'),
    group: 'Document',
    summary: tKey('Read the document as large, single-column text instead of page images.'),
    icon: 'BookOpen',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false
  },
  {
    id: 'history',
    title: tKey('Edit history'),
    group: 'Document',
    summary: tKey('See every operation applied this session and export the log.'),
    icon: 'History',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false,
    worksWithoutDocument: true
  },
  {
    id: 'side-by-side',
    title: tKey('Side by side'),
    group: 'Document',
    summary: tKey('View this document next to another one, scroll and zoom kept in sync.'),
    icon: 'Columns2',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: tKey('Done'),
    selectable: false
  }
];

/**
 * DOC-10 — the route names the active tool, but that's only readable from a
 * `wouter-preact` hook, which `core/history.ts` (a plain module, no hooks) can't
 * call. `useActiveTool` keeps this in sync on every render of any component that
 * calls it (the shell always has at least one mounted), so `history.ts` can read
 * "which tool is the user in right now" as a plain signal instead.
 */
export const activeToolId = signal<ToolId | null>(null);

const BY_ID = new Map(TOOLS.map(tool => [tool.id, tool]));

export function findTool(id: string | undefined): ToolDefinition | null {
  return id ? (BY_ID.get(id as ToolId) ?? null) : null;
}

export function toolRoute(id: ToolId): string {
  return `/tool/${id}`;
}

/**
 * The display label (a translation key) for each group. `ToolGroup` values are
 * identifiers compared in code, so the label is looked up separately and
 * translated at render time: `t(toolGroupLabel(tool.group))`.
 */
const GROUP_LABELS: Record<ToolGroup, string> = {
  Organize: tKey('Organize'),
  Convert: tKey('Convert'),
  Optimize: tKey('Optimize'),
  Document: tKey('Document'),
  Automation: tKey('Automation')
};

export function toolGroupLabel(group: ToolGroup): string {
  return GROUP_LABELS[group];
}

/** Rail order: groups in declaration order, tools in declaration order. */
export function groupedTools(): { group: ToolGroup; tools: ToolDefinition[] }[] {
  const order: ToolGroup[] = ['Organize', 'Convert', 'Optimize', 'Document', 'Automation'];
  return order
    .map(group => ({ group, tools: TOOLS.filter(t => t.group === group) }))
    .filter(entry => entry.tools.length > 0);
}
