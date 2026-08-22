import type { MetadataFindings, ScrubSettings } from './workers/process.worker';

/**
 * RED-09 — batch metadata scrub reuses RED-04's per-item settings shape, but a
 * batch run has no panel to check boxes in. This builds the "strip everything
 * this particular file actually has" settings from its own findings, so file B's
 * scrub is never decided by file A's metadata.
 */
export function stripAllMetadataSettings(findings: MetadataFindings): ScrubSettings {
  const settings: ScrubSettings = {};
  const fields: (keyof MetadataFindings)[] = [
    'title',
    'author',
    'subject',
    'creator',
    'producer',
    'creationDate',
    'modificationDate',
    'keywords'
  ];
  const flags: (keyof MetadataFindings)[] = [
    'hasXmp',
    'hasEmbeddedJavaScript',
    'hasOpenAction',
    'hasAdditionalActions',
    'hasEmbeddedFiles',
    'hasPageThumbnails',
    'hasOptionalContent'
  ];
  for (const field of fields) {
    if (findings[field]) (settings as Record<string, boolean>)[field] = true;
  }
  for (const flag of flags) {
    if (findings[flag] === true) (settings as Record<string, boolean>)[flag] = true;
  }
  if (findings.hasCustomInfo) (settings as Record<string, boolean>).customInfo = true;
  return settings;
}

/** True when this file's own findings would have the scrubber remove something. */
export function hasAnyMetadataFinding(settings: ScrubSettings): boolean {
  return Object.values(settings).some(Boolean);
}

/**
 * How many distinct pieces of information a strip-all pass on `findings` actually
 * removes — not `Object.keys(settings).length`, which counts strip *toggles* and
 * so reports a document with seven non-standard Info entries as "1 finding" (the
 * single `customInfo` toggle that removes all seven).
 */
export function countMetadataFindings(findings: MetadataFindings): number {
  const fields: (keyof MetadataFindings)[] = [
    'title',
    'author',
    'subject',
    'creator',
    'producer',
    'creationDate',
    'modificationDate',
    'keywords'
  ];
  const flags: (keyof MetadataFindings)[] = [
    'hasXmp',
    'hasEmbeddedJavaScript',
    'hasOpenAction',
    'hasAdditionalActions',
    'hasEmbeddedFiles',
    'hasPageThumbnails',
    'hasOptionalContent'
  ];
  let count = fields.filter(field => findings[field]).length;
  count += flags.filter(flag => findings[flag] === true).length;
  if (findings.hasCustomInfo) count += Math.max(1, findings.customInfo.length);
  return count;
}
