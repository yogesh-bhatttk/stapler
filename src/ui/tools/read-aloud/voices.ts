/**
 * Audit 2026-09-25 PLT-5 — voice selection for read-aloud, kept pure (no DOM,
 * no Preact) so it can be unit-tested. A `SpeechSynthesisVoice` with
 * `localService === false` may synthesise on a remote server (Chrome's
 * "Google …" voices do), which would send the document's text off the device;
 * such voices are never offered and never used.
 */

/** On-device voices only — a non-local voice may synthesise on a remote server. */
export function localVoices(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices.filter(voice => voice.localService === true);
}

/**
 * The voice to speak with: the user's pick if it is still available locally,
 * else the local voice the OS marks as default, else one matching the UI
 * language, else the first local voice. `null` only when there is none.
 */
export function pickLocalVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferredUri: string | null,
  language: string
): SpeechSynthesisVoice | null {
  const local = localVoices(voices);
  if (local.length === 0) return null;
  const prefix = language.toLowerCase().split('-')[0];
  return (
    local.find(voice => voice.voiceURI === preferredUri) ??
    local.find(voice => voice.default) ??
    local.find(voice => voice.lang.toLowerCase().startsWith(prefix)) ??
    local[0]
  );
}
