/**
 * ACC-02 — read the document's extracted text aloud via the Web Speech
 * Synthesis API.
 *
 * Audit 2026-09-25 PLT-5: not every speech-synthesis voice is on-device.
 * Chrome's "Google …" voices (the default on ChromeOS, and on Linux without
 * speech-dispatcher) synthesise on Google's servers, so leaving
 * `utterance.voice` unset could send the document's text off the device —
 * invisibly to the page's CSP, DevTools, and every test that watches requests.
 * So this panel only ever speaks with a voice whose `localService` is `true`,
 * always sets it explicitly, and is disabled with an explanation when the
 * browser offers no local voice at all.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, Pause, Play, Square } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, extractPageText } from '../../../core/operations';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Field, Select, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import { readAloudProgress, readAloudRate, readAloudVoiceUri } from './state';
import { localVoices, pickLocalVoice } from './voices';
import { SpeechSession } from './speech-session';

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** The browser's local voices, kept current (Chrome populates them asynchronously). */
function useLocalVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
    hasSpeechSynthesis() ? localVoices(window.speechSynthesis.getVoices()) : []
  );
  useEffect(() => {
    if (!hasSpeechSynthesis()) return;
    const synth = window.speechSynthesis;
    const refresh = () => setVoices(localVoices(synth.getVoices()));
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => synth.removeEventListener('voiceschanged', refresh);
  }, []);
  return voices;
}

export function ReadAloudPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const bytesDocId = useRef<string | null>(null);
  // UI-15 — decides which speech request may still act; one per mount.
  const [session] = useState(() => new SpeechSession());
  const progress = readAloudProgress.value;
  const voices = useLocalVoices();
  const voice = pickLocalVoice(
    voices,
    readAloudVoiceUri.value,
    typeof navigator !== 'undefined' ? navigator.language : 'en'
  );

  // Leaving the tool (or the document changing) must not leave audio playing
  // over whatever the user looks at next. Idle and no current utterance
  // *before* the cancel (UI-15): Chrome answers cancel() with `onend`, which
  // would otherwise read as "page finished" and advance to the next one.
  useEffect(
    () => () => {
      session.dispose(hasSpeechSynthesis() ? window.speechSynthesis : null, () => {
        readAloudProgress.value = { ...readAloudProgress.value, status: 'idle', note: null };
      });
    },
    []
  );
  useEffect(() => {
    if (bytesDocId.current !== (doc?.id ?? null)) {
      setBytes(null);
      bytesDocId.current = doc?.id ?? null;
      session.stop(hasSpeechSynthesis() ? window.speechSynthesis : null, () => {
        readAloudProgress.value = { status: 'idle', pageIndex: 0, note: null };
      });
    }
  }, [doc?.id]);

  if (!doc) return null;

  if (!hasSpeechSynthesis()) {
    return (
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {t(
            'Read-aloud needs a browser with speech synthesis support (Chrome, Edge, or Firefox).'
          )}
        </p>
      </div>
    );
  }

  if (!voice) {
    return (
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {t(
            'Read-aloud is off: this browser offers no on-device voice. Its other voices ' +
              'synthesise speech on a remote server, which would send the text of your document ' +
              'off this device, so Stapler will not use them. Install a speech voice in your ' +
              'operating system settings, then reopen this tool.'
          )}
        </p>
      </div>
    );
  }

  const ensureBytes = async (): Promise<Uint8Array | null> => {
    if (bytes) return bytes;
    const fetched = await run({ label: t('Preparing text'), scope: 'read-aloud.prepare' }, job =>
      currentDocumentBytes(job)
    );
    if (fetched) setBytes(fetched);
    return fetched ?? null;
  };

  const speakPage = async (pageIndex: number, currentBytes: Uint8Array) => {
    // UI-15 — a Stop, another page, or leaving the tool while this page's text
    // is being extracted supersedes this request; it must not speak late.
    const token = session.begin();
    const layout = await extractPageText(currentBytes, pageIndex, 'text');
    if (!session.isLive(token)) return;
    const text = layout.replace(/\s+/g, ' ').trim();

    if (!text) {
      readAloudProgress.value = {
        status: 'playing',
        pageIndex,
        note: t('This page has no extractable text — skipped.')
      };
      goToPage(pageIndex + 1, currentBytes);
      return;
    }

    readAloudProgress.value = { status: 'playing', pageIndex, note: null };
    const utterance = new SpeechSynthesisUtterance(text);
    // Always explicit, and always a local voice (PLT-5): an unset voice lets
    // the browser fall back to its default, which may be a server-side one.
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = readAloudRate.value;
    utterance.onend = () => {
      // A stale utterance's `onend` can still fire after Stop or after the user
      // has already moved to a different page by hand — only auto-advance if
      // this is still the page actually in flight. Status and page number
      // alone are not enough: restarting the *same* page at a new speed
      // (below) cancels the old utterance and speaks a new one without
      // touching either, and Chrome fires `onend` — not `onerror` — for the
      // one `cancel()` merely interrupted. Only the utterance that is still
      // the current one actually reached the end of its text.
      if (!session.finished(utterance)) return;
      if (
        readAloudProgress.value.status === 'playing' &&
        readAloudProgress.value.pageIndex === pageIndex
      ) {
        goToPage(pageIndex + 1, currentBytes);
      }
    };
    session.speak(window.speechSynthesis, token, utterance);
  };

  const goToPage = (pageIndex: number, currentBytes: Uint8Array) => {
    if (pageIndex < 0) return;
    if (pageIndex >= doc.pages.length) {
      session.stop(window.speechSynthesis, () => {
        readAloudProgress.value = { status: 'idle', pageIndex: doc.pages.length - 1, note: null };
      });
      return;
    }
    void speakPage(pageIndex, currentBytes);
  };

  const handlePlay = async () => {
    if (progress.status === 'paused') {
      window.speechSynthesis.resume();
      readAloudProgress.value = { ...progress, status: 'playing' };
      return;
    }
    const ready = await ensureBytes();
    if (ready) void speakPage(progress.pageIndex, ready);
  };

  const handlePause = () => {
    window.speechSynthesis.pause();
    readAloudProgress.value = { ...progress, status: 'paused' };
  };

  const handleStop = () => {
    session.stop(window.speechSynthesis, () => {
      readAloudProgress.value = { status: 'idle', pageIndex: progress.pageIndex, note: null };
    });
  };

  const handleStep = async (delta: 1 | -1) => {
    const target = Math.max(0, Math.min(doc.pages.length - 1, progress.pageIndex + delta));
    if (progress.status === 'playing') {
      const ready = await ensureBytes();
      if (ready) void speakPage(target, ready);
    } else {
      readAloudProgress.value = { ...progress, pageIndex: target, note: null };
    }
  };

  return (
    <>
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {t('Reading page {current} of {total}.', {
            current: progress.pageIndex + 1,
            total: doc.pages.length
          })}
        </p>
        {progress.note && <p className={panelStyles.description}>{progress.note}</p>}
      </div>

      <div className={panelStyles.section} style={{ display: 'flex', gap: '8px' }}>
        <IconButton
          icon={ChevronLeft}
          aria-label={t('Previous page')}
          onClick={() => handleStep(-1)}
          disabled={progress.pageIndex === 0}
        />
        {progress.status === 'playing' ? (
          <Button icon={Pause} onClick={handlePause}>
            {t('Pause')}
          </Button>
        ) : (
          <Button icon={Play} onClick={handlePlay}>
            {progress.status === 'paused' ? t('Resume') : t('Play')}
          </Button>
        )}
        <Button
          icon={Square}
          variant="secondary"
          onClick={handleStop}
          disabled={progress.status === 'idle'}
        >
          {t('Stop')}
        </Button>
        <IconButton
          icon={ChevronRight}
          aria-label={t('Next page')}
          onClick={() => handleStep(1)}
          disabled={progress.pageIndex >= doc.pages.length - 1}
        />
      </div>

      {voices.length > 1 && (
        <div className={panelStyles.section}>
          <Field label={t('Voice (on-device only)')}>
            {id => (
              <Select
                id={id}
                value={voice.voiceURI}
                options={voices.map(option => ({
                  value: option.voiceURI,
                  label: `${option.name} (${option.lang})`
                }))}
                onChange={uri => {
                  readAloudVoiceUri.value = uri;
                }}
              />
            )}
          </Field>
        </div>
      )}

      <div className={panelStyles.section}>
        <Field label={t('Speed ({rate}x)', { rate: readAloudRate.value.toFixed(2) })}>
          {id => (
            <Slider
              id={id}
              min={0.5}
              max={2}
              step={0.05}
              value={readAloudRate.value}
              onChange={rate => {
                readAloudRate.value = rate;
                // A rate change only takes effect on the *next* utterance — the
                // Web Speech API has no way to alter one already speaking — so
                // restart the current page rather than let the slider lie.
                if (progress.status === 'playing' && bytes)
                  void speakPage(progress.pageIndex, bytes);
              }}
              ariaLabel={t('Reading speed')}
            />
          )}
        </Field>
      </div>
    </>
  );
}
