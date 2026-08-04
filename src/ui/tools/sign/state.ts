import { signal } from '@preact/signals';
import type { TextRegion } from '../../../core/workers/render.worker';

export type StampType = 'signature' | 'text' | 'date' | 'check';

export interface ActiveStamp {
  type: StampType;
  /** Signature id, for signature stamps. */
  signatureId?: string;
}

/** What the next click on the page will place, or null for "nothing armed". */
export const activeStamp = signal<ActiveStamp | null>(null);

/** SGN-04 suggestions, cleared as they are used. */
export const signatureSuggestions = signal<TextRegion[]>([]);
