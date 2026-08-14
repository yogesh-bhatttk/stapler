/**
 * ANN-03 — turns found text into ANN-01 highlight annotations.
 *
 * Nothing here searches: locating text is `findTextRegions` (the render worker's
 * `findText`, which RED's find-and-mark already uses), and this module only
 * converts the `TextRegion`s it returns into the annotation shape ANN-01 stores.
 * A second search implementation is exactly what this ticket exists to avoid.
 *
 * Kept pure and in `core/` for the same reason `patterns.ts` is: the geometry is
 * where this can go wrong, and it is testable here without a PDF or a canvas.
 *
 * The type import from the annotate layer mirrors `core/history.ts`, which already
 * owns `pageAnnotations` in its undo snapshot.
 */
import type { TextRegion } from './workers/render.worker';
import type { Annotation } from '../ui/tools/annotate/state';

/** One page of the workspace document, in the order `findText` indexed them. */
export interface HighlightPage {
  /** `PageRef.key` — what `pageAnnotations` is keyed by. */
  key: string;
  /** Displayed page height ÷ width, with rotation already applied. */
  aspect: number;
}

export interface PlacedHighlight {
  pageKey: string;
  annotation: Annotation;
}

export interface HighlightPlacement {
  highlights: PlacedHighlight[];
  /**
   * Matches whose page index has no page in the workspace document. Reported so
   * the panel can say the count it places is smaller than the count it found,
   * rather than dropping matches silently.
   */
  unplaced: number;
}

/**
 * A highlight is stored as a stroked segment (ANN-01's `highlight` type), not as
 * a rectangle: the rectangle type draws an outline, and only the freehand/highlight
 * path is drawn with the 0.5 multiply both the canvas overlay and the PDF export
 * use for highlighting.
 *
 * So the match's box becomes a horizontal segment down its vertical centre, with
 * the stroke as thick as the box. `strokeWidth` is a fraction of page *width*
 * (both `AnnotateOverlay` and `drawAnnotations` multiply it by the page width),
 * while the box's height is a fraction of page *height* — hence the aspect factor.
 * Getting that wrong is invisible on a square page and wrong by 40% on A4.
 */
export function highlightsForRegions(
  regions: readonly TextRegion[],
  pages: readonly HighlightPage[],
  color: string,
  newId: () => string = () => crypto.randomUUID()
): HighlightPlacement {
  const highlights: PlacedHighlight[] = [];
  let unplaced = 0;

  for (const region of regions) {
    const page = pages[region.pageIndex];
    if (!page) {
      unplaced++;
      continue;
    }
    const centerY = region.y + region.height / 2;
    highlights.push({
      pageKey: page.key,
      annotation: {
        id: newId(),
        type: 'highlight',
        color,
        strokeWidth: Math.max(region.height * page.aspect, 0.001),
        points: [
          { x: region.x, y: centerY },
          { x: region.x + region.width, y: centerY }
        ]
      }
    });
  }

  return { highlights, unplaced };
}
