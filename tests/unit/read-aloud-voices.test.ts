import { describe, expect, it } from 'vitest';
import { localVoices, pickLocalVoice } from '../../src/ui/tools/read-aloud/voices';

/**
 * Audit 2026-09-25 PLT-5 — read-aloud must never speak with a voice that may
 * synthesise on a remote server. Chrome marks those `localService: false`
 * (its "Google …" voices), and one of them is often the browser default, which
 * is what an unset `utterance.voice` falls back to.
 */
const voice = (
  name: string,
  lang: string,
  localService: boolean,
  isDefault = false
): SpeechSynthesisVoice =>
  ({
    name,
    lang,
    localService,
    default: isDefault,
    voiceURI: `uri:${name}`
  }) as SpeechSynthesisVoice;

const googleDefault = voice('Google US English', 'en-US', false, true);
const googleHindi = voice('Google हिन्दी', 'hi-IN', false);
const espeakEn = voice('eSpeak English', 'en-GB', true);
const espeakHi = voice('eSpeak Hindi', 'hi-IN', true);

describe('read-aloud voice selection', () => {
  it('never offers a network voice', () => {
    expect(localVoices([googleDefault, espeakEn, googleHindi, espeakHi])).toEqual([
      espeakEn,
      espeakHi
    ]);
  });

  it('returns null — tool disabled — when every voice is a network voice', () => {
    expect(pickLocalVoice([googleDefault, googleHindi], null, 'en-US')).toBeNull();
    expect(pickLocalVoice([], null, 'en-US')).toBeNull();
  });

  it('does not follow the browser default when the default is a network voice', () => {
    expect(pickLocalVoice([googleDefault, espeakHi, espeakEn], null, 'en-US')).toBe(espeakEn);
  });

  it("keeps the user's pick, but only while it is still a local voice", () => {
    expect(pickLocalVoice([espeakEn, espeakHi], 'uri:eSpeak Hindi', 'en-US')).toBe(espeakHi);
    // A remembered URI that now names a network voice is ignored.
    expect(pickLocalVoice([googleHindi, espeakEn], 'uri:Google हिन्दी', 'hi-IN')).toBe(espeakEn);
  });

  it('prefers the OS default among local voices, then the UI language', () => {
    const localDefault = voice('Samantha', 'en-US', true, true);
    expect(pickLocalVoice([espeakHi, localDefault], null, 'hi-IN')).toBe(localDefault);
    expect(pickLocalVoice([espeakEn, espeakHi], null, 'hi')).toBe(espeakHi);
  });
});
