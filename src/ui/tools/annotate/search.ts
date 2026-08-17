import { commit } from '../../../core/history';
import { currentDocumentBytes, findTextRegions } from '../../../core/operations';
import { displayedAspectRatio } from '../../../core/rotation';
import { notify } from '../../../core/notify';
import { activeDoc, sources, type StaplerDoc } from '../../../core/store';
import { highlightsForRegions, type HighlightPage } from '../../../core/highlight';
import type { JobOptions } from '../../../core/workers/protocol';
import { addAnnotations, annotationColor } from './state';

export interface SearchHighlightResult {
  applied: boolean;
  matches: number;
  unplaced: number;
}

function highlightPagesFor(doc: StaplerDoc): HighlightPage[] {
  return doc.pages.map(page => {
    const size = sources.value[page.sourceDocId]?.pageSizes[page.sourceIndex];
    return {
      key: page.key,
      aspect: 1 / displayedAspectRatio(size?.width ?? 0, size?.height ?? 0, page.rotation)
    };
  });
}

/**
 * ANN-03 — runs the text search, then turns the found regions into highlights.
 *
 * The guard after the async search is what prevents a stale search result from
 * landing on a different document if the user switches tabs while the worker is
 * still scanning.
 */
export async function searchAndHighlightMatches(
  query: string,
  matchCase: boolean,
  job: JobOptions
): Promise<SearchHighlightResult> {
  const current = activeDoc.value;
  if (!current) return { applied: false, matches: 0, unplaced: 0 };

  const docId = current.id;
  const trimmed = query.trim();
  const bytes = await currentDocumentBytes(job);
  const found = await findTextRegions(bytes, trimmed, matchCase, job);

  if (activeDoc.value?.id !== docId) {
    return { applied: false, matches: 0, unplaced: 0 };
  }

  if (found.length === 0) {
    notify('warning', `No matches for "${trimmed}".`);
    return { applied: false, matches: 0, unplaced: 0 };
  }

  const pages = highlightPagesFor(current);
  const { highlights, unplaced } = highlightsForRegions(found, pages, annotationColor.value);

  if (activeDoc.value?.id !== docId) {
    return { applied: false, matches: 0, unplaced: 0 };
  }

  if (highlights.length === 0) {
    notify('warning', `No matches for "${trimmed}" on any page of this document.`);
    return { applied: false, matches: 0, unplaced: 0 };
  }

  commit();
  addAnnotations(highlights);
  notify('info', `Highlighted ${highlights.length} match(es).`, {
    detail:
      unplaced > 0
        ? `${unplaced} match(es) fell outside this document's pages and were not highlighted. Undo removes the whole search.`
        : 'Undo removes the whole search in one step; each highlight is an ordinary annotation you can move or delete.'
  });

  return { applied: true, matches: highlights.length, unplaced };
}
