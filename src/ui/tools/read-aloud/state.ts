import { signal } from '@preact/signals';
import { readSetting, writeSetting } from '../../../core/db';
import type { TextRange } from './sentences';

export type ReadAloudStatus = 'idle' | 'playing' | 'paused';

export interface ReadAloudProgress {
  status: ReadAloudStatus;
  pageIndex: number;
  /** GAP-10 — which sentence of the page is (or will next be) spoken. */
  sentenceIndex: number;
  /** Set when the current page had no extractable text and was skipped. */
  note: string | null;
}

export const readAloudProgress = signal<ReadAloudProgress>({
  status: 'idle',
  pageIndex: 0,
  sentenceIndex: 0,
  note: null
});

/** GAP-10 — the text of the page being read, split into sentences for highlighting. */
export interface ReadAloudPageText {
  /** UI-1 — `pageListKey(doc)` of the page list this text was extracted from. */
  docKey: string;
  pageIndex: number;
  text: string;
  sentences: TextRange[];
}

export const readAloudPageText = signal<ReadAloudPageText | null>(null);

/**
 * The word being spoken, as a range into `readAloudPageText.text`, while the
 * voice reports `boundary` events. Null when it does not (many on-device
 * voices never fire them) — only the sentence is highlighted then.
 */
export const readAloudWord = signal<TextRange | null>(null);

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

/** Speech rate, the same 0.5-2x range every OS speech UI offers. */
export const readAloudRate = signal<number>(1);

/**
 * The chosen voice's `voiceURI`, or `null` for "the best on-device default".
 * Only ever a voice with `localService === true` — see `ReadAloudPanel`.
 */
export const readAloudVoiceUri = signal<string | null>(null);

/* ---------------- GAP-10 — remembered voice and rate ---------------- */

/**
 * Persisted with the app's own IndexedDB settings store (`core/db.ts`), the
 * same place saved shortcuts and the theme live — never `chrome.storage`,
 * which would need the layer boundary and a permission.
 */
const RATE_KEY = 'readAloud.rate';
const VOICE_KEY = 'readAloud.voiceUri';

let preferencesLoaded: Promise<void> | null = null;
// Set once the user picks a voice/rate this session, so a slow settings read
// landing afterwards does not overwrite the fresher choice.
let rateTouched = false;
let voiceTouched = false;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, rate));
}

/** Loads the remembered voice and rate once per session; later calls reuse it. */
export function loadReadAloudPreferences(): Promise<void> {
  if (!preferencesLoaded) {
    preferencesLoaded = (async () => {
      try {
        const [rate, voice] = await Promise.all([
          readSetting<unknown>(RATE_KEY),
          readSetting<unknown>(VOICE_KEY)
        ]);
        if (typeof rate === 'number' && !rateTouched) readAloudRate.value = clampRate(rate);
        if (typeof voice === 'string' && voice.length > 0 && !voiceTouched) {
          readAloudVoiceUri.value = voice;
        }
      } catch {
        // Unreadable storage: keep the defaults; nothing to recover.
      }
    })();
  }
  return preferencesLoaded;
}

let rateWriteTimer: ReturnType<typeof setTimeout> | null = null;

/** Sets the rate now; persists it once the slider settles, not on every step of a drag. */
export function setReadAloudRate(rate: number): void {
  const next = clampRate(rate);
  rateTouched = true;
  readAloudRate.value = next;
  if (rateWriteTimer) clearTimeout(rateWriteTimer);
  rateWriteTimer = setTimeout(() => {
    rateWriteTimer = null;
    void writeSetting(RATE_KEY, readAloudRate.value).catch(() => {});
  }, 300);
}

export function setReadAloudVoice(voiceUri: string): void {
  voiceTouched = true;
  readAloudVoiceUri.value = voiceUri;
  void writeSetting(VOICE_KEY, voiceUri).catch(() => {});
}

export function __resetReadAloudPreferencesForTests(): void {
  preferencesLoaded = null;
  rateTouched = false;
  voiceTouched = false;
  if (rateWriteTimer) clearTimeout(rateWriteTimer);
  rateWriteTimer = null;
  readAloudRate.value = 1;
  readAloudVoiceUri.value = null;
}
