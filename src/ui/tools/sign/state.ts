import { effect, signal, untracked } from '@preact/signals';
import { activeToolId } from '../../../core/tools';
import { resetOnDocumentChange } from '../docScoped';
import type { TextRegion } from '../../../core/workers/render.worker';
import type { FormFieldData, SignatureIntegrityReport } from '../../../core/workers/process.worker';
import type { FormulaDefinition } from '../../../core/formula';

export type StampType =
  'signature' | 'text' | 'date' | 'check' | 'form-text' | 'form-checkbox' | 'form-radio';

export interface ActiveStamp {
  type: StampType;
  /** Signature id, for signature stamps. */
  signatureId?: string;
}

/** What the next click on the page will place, or null for "nothing armed". */
export const activeStamp = signal<ActiveStamp | null>(null);

/** SGN-04 suggestions, cleared as they are used. */
export const signatureSuggestions = signal<TextRegion[]>([]);

/** Extracted form fields for the currently active document. */
export const formFields = signal<{ isXfa: boolean; fields: FormFieldData[] } | null>(null);

/** User's interactive inputs for form fields. */
export const formValues = signal<Record<string, string | string[] | boolean>>({});

/** SGN-07 — user-designated calculated fields, in-session only (see ticket writeup). */
export const formulas = signal<FormulaDefinition[]>([]);

/** SGN-09 — null until checked, or when the open document has no /Sig field. */
export const signatureIntegrity = signal<SignatureIntegrityReport | null>(null);

// Suggestions are page-index coordinates from one revision of one document, and
// an armed stamp is an intent for this document: neither may carry over (UI-12).
resetOnDocumentChange(
  () => {
    signatureSuggestions.value = [];
  },
  { onPageEdits: true }
);
resetOnDocumentChange(() => {
  activeStamp.value = null;
});

// AnnotationOverlay is mounted for several single-page tools, so a stamp armed
// in Sign used to be placed by a click in Outline or Normalize (UI-12).
effect(() => {
  void activeToolId.value;
  untracked(() => {
    activeStamp.value = null;
  });
});
