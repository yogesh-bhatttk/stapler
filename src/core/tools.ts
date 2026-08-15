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

export type ToolId =
  | 'merge'
  | 'organize'
  | 'split'
  | 'insert'
  | 'remove-blanks'
  | 'cleanup'
  | 'pdf-to-img'
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
  | 'ocr'
  | 'acc'
  | 'contact-sheet'
  | 'shortcuts';

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
    title: 'Merge',
    group: 'Organize',
    summary: 'Combine several PDFs and images into one document.',
    icon: 'Layers',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: false
  },
  {
    id: 'organize',
    title: 'Organize',
    group: 'Organize',
    summary: 'Rotate, delete, duplicate, and reorder pages.',
    icon: 'LayoutGrid',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: true
  },
  {
    id: 'split',
    title: 'Split & extract',
    group: 'Organize',
    summary: 'Extract a selection, or split into several files.',
    icon: 'SplitSquareHorizontal',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Split / extract',
    selectable: true
  },
  {
    id: 'remove-blanks',
    title: 'Remove blanks',
    group: 'Organize',
    summary: 'Find blank pages and confirm before removing them.',
    icon: 'Eraser',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Delete selected',
    selectable: true
  },
  {
    id: 'nup',
    title: 'N-up & Booklet',
    group: 'Organize',
    summary: 'Impose pages into 2-up, 4-up, or booklet layouts.',
    icon: 'BookOpen',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export layout',
    selectable: false
  },
  {
    id: 'cleanup',
    title: 'Scan cleanup',
    group: 'Optimize',
    summary: 'Straighten and whiten a photographed or scanned page.',
    icon: 'Sparkles',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Apply & export',
    selectable: false
  },
  {
    id: 'compress',
    title: 'Compress',
    group: 'Optimize',
    summary: 'Reduce file size, and say honestly when there is nothing to gain.',
    icon: 'Minimize2',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Compress & export',
    selectable: false
  },
  {
    id: 'crop',
    title: 'Crop',
    group: 'Organize',
    summary: 'Crop margins manually or automatically trim white space.',
    icon: 'Crop',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: false
  },
  {
    id: 'watermark',
    title: 'Watermark',
    group: 'Organize',
    summary: 'Add text watermarks or page numbers.',
    icon: 'Stamp',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: false
  },
  {
    id: 'outline',
    title: 'Bookmarks',
    group: 'Document',
    summary: 'Edit the document outline: rename, add, delete, and reorder bookmarks.',
    icon: 'ListTree',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: false
  },
  {
    id: 'normalize',
    title: 'Normalize',
    group: 'Organize',
    summary: 'Resize documents with mixed page sizes to a uniform standard size.',
    icon: 'Scaling',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Normalize & export',
    selectable: false
  },
  {
    id: 'pdf-to-img',
    title: 'PDF to images',
    group: 'Convert',
    summary: 'Export pages as PNG or JPEG at a chosen resolution.',
    icon: 'Image',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export images',
    selectable: true
  },
  {
    id: 'extract-img',
    title: 'Extract images',
    group: 'Convert',
    summary: 'Pull embedded photos and artwork out at their original quality.',
    icon: 'ImageDown',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Extract images',
    selectable: true
  },
  {
    id: 'extract',
    title: 'Extract text',
    group: 'Convert',
    summary: 'Pull out plain text or Markdown in reading order.',
    icon: 'FileText',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: true
  },
  {
    id: 'sign',
    title: 'Sign & fill',
    group: 'Document',
    summary: 'Place a stamped signature, text, dates, and check marks.',
    icon: 'PenTool',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export signed PDF',
    selectable: false
  },
  {
    id: 'redact',
    title: 'Redact',
    group: 'Document',
    summary: 'Remove content permanently, then prove it was removed.',
    icon: 'ShieldAlert',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Verify & apply',
    selectable: false
  },
  {
    id: 'ocr',
    title: 'OCR text layer',
    group: 'Document',
    summary: 'Read the text in a scan and add an invisible, searchable text layer.',
    icon: 'ScanText',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Run OCR & export',
    // A scan is often a handful of pages inside a longer document, and OCR is by
    // far the slowest operation here — running it on pages that already have text
    // would cost minutes for nothing.
    selectable: true
  },
  {
    id: 'metadata',
    title: 'Metadata',
    group: 'Document',
    summary: 'See what the file reveals about you, and strip it.',
    icon: 'FileSearch',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Strip & export',
    selectable: false
  },
  {
    id: 'acc',
    title: 'Alt-text editor',
    group: 'Document',
    summary: 'Attach alt-text to images for PDF/UA accessibility.',
    icon: 'Accessibility',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Tag & export',
    selectable: false
  },
  {
    id: 'contact-sheet',
    title: 'Contact sheet',
    group: 'Document',
    summary: 'Export a grid of page thumbnails as a single PDF.',
    icon: 'LayoutGrid',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    selectable: false
  },
  {
    id: 'shortcuts',
    title: 'Custom shortcuts',
    group: 'Document',
    summary: 'View and customise keyboard shortcuts.',
    icon: 'Keyboard',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Done',
    selectable: false
  },
  {
    id: 'compare',
    title: 'Compare',
    group: 'Document',
    summary: 'Compare two PDFs and view visual or text differences.',
    icon: 'GitPullRequest',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Done',
    selectable: false
  },
  {
    id: 'annotate',
    title: 'Annotate',
    group: 'Document',
    summary: 'Draw highlights, shapes, and text notes on the document.',
    icon: 'PenTool',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export annotated PDF',
    selectable: false
  },
  {
    id: 'insert',
    title: 'Insert pages',
    group: 'Organize',
    summary: 'Drop pages from another document at a chosen position.',
    icon: 'FilePlus',
    canvasMode: 'grid',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    // Selecting a page in the grid sets the insertion anchor — the panel inserts
    // right after the last selected page.
    selectable: true
  },
  {
    id: 'batch',
    title: 'Batch process',
    group: 'Automation',
    summary: 'Apply a recipe of operations to a folder of PDFs.',
    icon: 'FolderOpen',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Run Batch',
    selectable: false,
    worksWithoutDocument: true
  },
  {
    id: 'md-to-pdf',
    group: 'Convert',
    title: 'Markdown to PDF',
    summary: 'Convert a Markdown file or text into a PDF.',
    icon: 'FileText',
    canvasMode: 'single',
    needsOptionsPanel: true,
    commitLabel: 'Export PDF',
    worksWithoutDocument: true,
    selectable: false
  }
];

const BY_ID = new Map(TOOLS.map(tool => [tool.id, tool]));

export function findTool(id: string | undefined): ToolDefinition | null {
  return id ? (BY_ID.get(id as ToolId) ?? null) : null;
}

export function toolRoute(id: ToolId): string {
  return `/tool/${id}`;
}

/** Rail order: groups in declaration order, tools in declaration order. */
export function groupedTools(): { group: ToolGroup; tools: ToolDefinition[] }[] {
  const order: ToolGroup[] = ['Organize', 'Convert', 'Optimize', 'Document', 'Automation'];
  return order
    .map(group => ({ group, tools: TOOLS.filter(t => t.group === group) }))
    .filter(entry => entry.tools.length > 0);
}
