import { signal } from '@preact/signals';
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
