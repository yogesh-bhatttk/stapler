/**
 * NFR-03 — the Compress tool's whole-document pre-flight, run once however
 * many parts of the tool ask for it at the same time.
 *
 * The preview analyses the document as soon as it mounts, and the panel's
 * "Analyse" button and its debounced re-projection each ran their own
 * `currentDocumentBytes` + `planCompression` on top. Each run composes the
 * whole document and parses it in two workers, so on a 100 MB file two
 * overlapping runs cost several hundred megabytes for one answer. Callers
 * asking about the same document revision at the same settings now share the
 * run in flight; each keeps its own cancellation (`createSharedJob`).
 */
import { activeDoc } from '../../../core/store';
import { internal } from '../../../core/errors';
import {
  currentDocumentBytes,
  planCompression,
  type CompressionReport
} from '../../../core/operations';
import { createSharedJob } from '../../../core/shared-job';
import type { JobOptions } from '../../../core/workers/protocol';
import type { CompressSettings } from './state';

const analyses = createSharedJob<CompressionReport>();

/** The active document's compression pre-flight at `settings`. */
export function analyseActiveDocument(
  settings: CompressSettings,
  options: JobOptions = {}
): Promise<CompressionReport> {
  const doc = activeDoc.value;
  if (!doc) return Promise.reject(internal('No document is open.'));
  const { dpi, quality } = settings;
  // Keyed by document and settings; the document revision's identity is the
  // token (every edit replaces it), so an edit made while a run is in flight
  // starts a fresh one instead of joining an analysis of the pages as they were.
  return analyses.run(`${doc.id}|${dpi}|${quality}`, doc, options, async job => {
    const bytes = await currentDocumentBytes(job);
    return planCompression(bytes, { dpi, quality }, job);
  });
}

/** Analyses in flight, for tests. */
export const __analysesInFlight = () => analyses.size;
