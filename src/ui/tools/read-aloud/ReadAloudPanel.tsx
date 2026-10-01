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
 *
 * GAP-10 — read-aloud basics:
 *  • the page's text is shown with the current sentence highlighted, and the
 *    current word too while the voice fires `boundary` events. It speaks one
 *    sentence per utterance (see `sentences.ts`), so the sentence highlight
 *    works even with voices that never fire them;
 *  • the chosen voice and rate are remembered (the app's IndexedDB settings);
 *  • keyboard: Space plays/pauses, ←/→ move by sentence, Page Up/Page Down by
 *    page, while focus is inside the panel;
 *  • the status line is a polite live region, so a screen reader hears
 *    play/pause/page changes without every word being announced.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Fragment, type JSX } from 'preact';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pause,
  Play,
  Square
} from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, extractPageText } from '../../../core/operations';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Field, Select, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import {
  loadReadAloudPreferences,
  MAX_RATE,
  MIN_RATE,
  readAloudPageText,
  readAloudProgress,
  readAloudRate,
  readAloudVoiceUri,
  readAloudWord,
  setReadAloudRate,
  setReadAloudVoice,
  type ReadAloudPageText
} from './state';
import { localVoices, pickLocalVoice, preferredVoiceMissing } from './voices';
import { pageListKey } from '../../../core/page-version';
import { SpeechSession } from './speech-session';
import { clampSentence, splitSentences, wordRangeAt } from './sentences';
import styles from './ReadAloudPanel.module.css';

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

/** Keys the panel must leave to the focused control itself. */
function isOwnKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    target.isContentEditable ||
    target.getAttribute('role') === 'slider' ||
    target.getAttribute('role') === 'combobox' ||
    target.getAttribute('role') === 'listbox'
  );
}

export function ReadAloudPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  // UI-1 — the bytes and text are for one *page list*, not just one document
  // id: deleting or moving a page must not leave Play reading the old page.
  const docKey = doc ? pageListKey(doc) : null;
  const bytesKey = useRef<string | null>(null);
  // The key as of the latest render, for async work to check it is still current.
  const liveKey = useRef<string | null>(docKey);
  liveKey.current = docKey;
  // Extracted, sentence-split page text for the current bytes, by page index.
  const textCache = useRef(new Map<number, ReadAloudPageText>());
  const currentSentenceRef = useRef<HTMLSpanElement | null>(null);
  // UI-15 — decides which speech request may still act; one per mount.
  const [session] = useState(() => new SpeechSession());
  const progress = readAloudProgress.value;
  const pageText = readAloudPageText.value;
  const word = readAloudWord.value;
  const voices = useLocalVoices();
  const voice = pickLocalVoice(
    voices,
    readAloudVoiceUri.value,
    typeof navigator !== 'undefined' ? navigator.language : 'en'
  );
  const voiceMissing = preferredVoiceMissing(voices, readAloudVoiceUri.value);

  useEffect(() => {
    void loadReadAloudPreferences();
  }, []);

  // Leaving the tool (or the document changing) must not leave audio playing
  // over whatever the user looks at next. Idle and no current utterance
  // *before* the cancel (UI-15): Chrome answers cancel() with `onend`, which
  // would otherwise read as "page finished" and advance to the next one.
  useEffect(
    () => () => {
      session.dispose(hasSpeechSynthesis() ? window.speechSynthesis : null, () => {
        readAloudProgress.value = { ...readAloudProgress.value, status: 'idle', note: null };
        readAloudWord.value = null;
      });
    },
    []
  );
  useEffect(() => {
    if (bytesKey.current !== docKey) {
      setBytes(null);
      textCache.current.clear();
      bytesKey.current = docKey;
      session.stop(hasSpeechSynthesis() ? window.speechSynthesis : null, () => {
        readAloudProgress.value = { status: 'idle', pageIndex: 0, sentenceIndex: 0, note: null };
        readAloudPageText.value = null;
        readAloudWord.value = null;
      });
    }
  }, [docKey]);

  // Keep the sentence being read in view in the text box.
  useEffect(() => {
    currentSentenceRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [progress.sentenceIndex, progress.pageIndex, pageText]);

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

  const synth = window.speechSynthesis;

  const ensureBytes = async (): Promise<Uint8Array | null> => {
    if (bytes && bytesKey.current === docKey) return bytes;
    const requestedKey = docKey;
    const fetched = await run({ label: t('Preparing text'), scope: 'read-aloud.prepare' }, job =>
      currentDocumentBytes(job)
    );
    // UI-1 — the pages changed while the bytes were being built: they are
    // the old document's, so neither keep nor speak them.
    if (!fetched || liveKey.current !== requestedKey) return null;
    setBytes(fetched);
    return fetched;
  };

  const loadPage = async (
    pageIndex: number,
    currentBytes: Uint8Array
  ): Promise<ReadAloudPageText> => {
    const cached = textCache.current.get(pageIndex);
    if (cached) return cached;
    const requestedKey = docKey;
    const layout = await extractPageText(currentBytes, pageIndex, 'text');
    const text = layout.replace(/\s+/g, ' ').trim();
    const entry: ReadAloudPageText = {
      docKey: requestedKey ?? doc.id,
      pageIndex,
      text,
      sentences: splitSentences(text, voice.lang)
    };
    if (liveKey.current === requestedKey) textCache.current.set(pageIndex, entry);
    return entry;
  };

  /** UI-2 — a failed extraction or a synthesis error: back to idle, with a note saying why. */
  const failTo = (note: string) => {
    session.stop(synth, () => {
      readAloudProgress.value = { ...readAloudProgress.value, status: 'idle', note };
      readAloudWord.value = null;
    });
  };

  /** Speaks sentence `index` of `page` for request `token`, then the rest of the document. */
  const speakSentence = (
    token: number,
    page: ReadAloudPageText,
    index: number,
    currentBytes: Uint8Array,
    note: string | null = null
  ) => {
    if (!session.isLive(token)) return;
    const range = page.sentences[index];
    readAloudPageText.value = page;
    readAloudWord.value = null;
    readAloudProgress.value = {
      status: 'playing',
      pageIndex: page.pageIndex,
      sentenceIndex: index,
      // UI-10 — a "page skipped" note stays up while the next sentence plays.
      note
    };
    const utterance = new SpeechSynthesisUtterance(page.text.slice(range.start, range.end));
    // Always explicit, and always a local voice (PLT-5): an unset voice lets
    // the browser fall back to its default, which may be a server-side one.
    // Re-picked from the live preference, so a voice change made mid-read
    // applies to the very next sentence.
    const speakingVoice = pickLocalVoice(voices, readAloudVoiceUri.value, voice.lang) ?? voice;
    utterance.voice = speakingVoice;
    utterance.lang = speakingVoice.lang;
    utterance.rate = readAloudRate.value;
    utterance.onboundary = event => {
      if (!session.finished(utterance)) return;
      if (event.name && event.name !== 'word') return;
      readAloudWord.value = wordRangeAt(page.text, range, event.charIndex, event.charLength);
    };
    utterance.onerror = event => {
      // UI-2 — `interrupted`/`canceled` are our own cancel() (Stop, a step, a
      // restart at a new speed); anything else would leave the panel stuck on
      // "Reading page N" with nothing being read.
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      if (!session.finished(utterance)) return;
      failTo(
        t('Reading stopped: the voice reported an error ({error}).', {
          error: event.error || t('unknown')
        })
      );
    };
    utterance.onend = () => {
      // Only the utterance that is still current actually reached the end of
      // its text: Chrome answers `cancel()` (Stop, a step, a restart at a new
      // speed) with `onend`, not `onerror` (UI-15).
      if (!session.finished(utterance)) return;
      if (readAloudProgress.value.status !== 'playing') return;
      readAloudWord.value = null;
      if (index + 1 < page.sentences.length) {
        speakSentence(token, page, index + 1, currentBytes);
      } else {
        goToPage(page.pageIndex + 1, currentBytes, null);
      }
    };
    // A paused synthesiser stays paused across cancel(): a step or restart
    // made while paused would otherwise queue silently.
    if (synth.paused) synth.resume();
    session.speak(synth, token, utterance);
  };

  /** UI-2 — a page's text, or null (and the panel reset with a note) when extraction fails. */
  const loadPageOrFail = async (
    token: number | null,
    pageIndex: number,
    currentBytes: Uint8Array
  ): Promise<ReadAloudPageText | null> => {
    try {
      return await loadPage(pageIndex, currentBytes);
    } catch {
      if (token === null || session.isLive(token)) {
        failTo(t('Could not read the text of page {page}.', { page: pageIndex + 1 }));
      }
      return null;
    }
  };

  const speakFrom = async (
    pageIndex: number,
    sentence: number | 'last',
    currentBytes: Uint8Array,
    note: string | null = null
  ) => {
    // UI-15 — a Stop, another step, or leaving the tool while this page's
    // text is being extracted supersedes this request; it must not speak late.
    const token = session.begin();
    const page = await loadPageOrFail(token, pageIndex, currentBytes);
    if (!page || !session.isLive(token)) return;
    readAloudPageText.value = page;
    readAloudWord.value = null;

    if (page.sentences.length === 0) {
      const skipped = t('This page has no extractable text — skipped.');
      readAloudProgress.value = {
        status: 'playing',
        pageIndex,
        sentenceIndex: 0,
        note: skipped
      };
      goToPage(pageIndex + 1, currentBytes, skipped);
      return;
    }
    const index =
      sentence === 'last'
        ? page.sentences.length - 1
        : clampSentence(sentence, page.sentences.length);
    speakSentence(token, page, index, currentBytes, note);
  };

  const goToPage = (pageIndex: number, currentBytes: Uint8Array, note: string | null) => {
    if (pageIndex < 0) return;
    if (pageIndex >= doc.pages.length) {
      // UI-10 — the end of the document: back to the start, so the next Play
      // reads the document again rather than only its last sentence. A
      // "skipped" note for the last page stays visible.
      session.stop(synth, () => {
        readAloudProgress.value = { status: 'idle', pageIndex: 0, sentenceIndex: 0, note };
        readAloudWord.value = null;
      });
      return;
    }
    void speakFrom(pageIndex, 0, currentBytes, note);
  };

  const handlePlay = async () => {
    const current = readAloudProgress.value;
    if (current.status === 'paused') {
      synth.resume();
      readAloudProgress.value = { ...current, status: 'playing' };
      return;
    }
    const ready = await ensureBytes();
    if (ready) void speakFrom(current.pageIndex, current.sentenceIndex, ready);
  };

  const handlePause = () => {
    synth.pause();
    readAloudProgress.value = { ...readAloudProgress.value, status: 'paused' };
  };

  const togglePlay = () => {
    if (readAloudProgress.value.status === 'playing') handlePause();
    else void handlePlay();
  };

  const handleStop = () => {
    session.stop(synth, () => {
      readAloudProgress.value = { ...readAloudProgress.value, status: 'idle', note: null };
      readAloudWord.value = null;
    });
  };

  const handlePageStep = async (delta: 1 | -1) => {
    const current = readAloudProgress.value;
    const target = Math.max(0, Math.min(doc.pages.length - 1, current.pageIndex + delta));
    if (current.status !== 'idle') {
      const ready = await ensureBytes();
      if (ready) void speakFrom(target, 0, ready);
    } else {
      readAloudProgress.value = { ...current, pageIndex: target, sentenceIndex: 0, note: null };
      readAloudWord.value = null;
      if (readAloudPageText.value?.pageIndex !== target) readAloudPageText.value = null;
    }
  };

  /** Next/previous sentence: starts (or keeps) speaking from there, crossing pages. */
  const handleSentenceStep = async (delta: 1 | -1) => {
    const ready = await ensureBytes();
    if (!ready) return;
    const { pageIndex, sentenceIndex } = readAloudProgress.value;
    const page = await loadPageOrFail(null, pageIndex, ready);
    if (!page) return;
    const target = sentenceIndex + delta;
    if (target < 0) {
      void speakFrom(Math.max(0, pageIndex - 1), pageIndex > 0 ? 'last' : 0, ready);
    } else if (target >= page.sentences.length) {
      if (pageIndex + 1 < doc.pages.length) void speakFrom(pageIndex + 1, 0, ready);
    } else {
      speakSentence(session.begin(), page, target, ready);
    }
  };

  const restartCurrentSentence = () => {
    const current = readAloudProgress.value;
    const page = readAloudPageText.value;
    if (current.status !== 'playing' || !bytes || !page || page.pageIndex !== current.pageIndex) {
      return;
    }
    // A rate or voice change only takes effect on the *next* utterance — the
    // Web Speech API cannot alter one already speaking — so restart the
    // current sentence rather than let the control lie.
    if (page.sentences[current.sentenceIndex]) {
      speakSentence(session.begin(), page, current.sentenceIndex, bytes);
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isOwnKeyTarget(event.target)) return;
    const onButton = event.target instanceof HTMLElement && event.target.tagName === 'BUTTON';
    switch (event.key) {
      case ' ':
        // Space on a focused button already presses that button.
        if (onButton) return;
        togglePlay();
        break;
      case 'ArrowRight':
        void handleSentenceStep(1);
        break;
      case 'ArrowLeft':
        void handleSentenceStep(-1);
        break;
      case 'PageDown':
        void handlePageStep(1);
        break;
      case 'PageUp':
        void handlePageStep(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    // The workspace's own arrow/page shortcuts must not also act.
    event.stopPropagation();
  };

  const pageParams = { current: progress.pageIndex + 1, total: doc.pages.length };
  const statusText =
    progress.status === 'playing'
      ? t('Reading page {current} of {total}.', pageParams)
      : progress.status === 'paused'
        ? t('Paused on page {current} of {total}.', pageParams)
        : t('Ready to read page {current} of {total}.', pageParams);

  const shownText =
    pageText && pageText.docKey === docKey && pageText.pageIndex === progress.pageIndex
      ? pageText
      : null;

  const renderSentence = (index: number) => {
    if (!shownText) return null;
    const range = shownText.sentences[index];
    const text = shownText.text;
    const isCurrent = index === progress.sentenceIndex && progress.status !== 'idle';
    if (!isCurrent) {
      return <span key={index}>{text.slice(range.start, range.end)}</span>;
    }
    const inWord = word && word.start >= range.start && word.end <= range.end ? word : null;
    return (
      <span key={index} ref={currentSentenceRef} className={styles.sentence} aria-current="true">
        {inWord ? (
          <>
            {text.slice(range.start, inWord.start)}
            <mark className={styles.word}>{text.slice(inWord.start, inWord.end)}</mark>
            {text.slice(inWord.end, range.end)}
          </>
        ) : (
          text.slice(range.start, range.end)
        )}
      </span>
    );
  };

  return (
    <div onKeyDown={onKeyDown}>
      <div className={panelStyles.section}>
        <p className={panelStyles.description} role="status" aria-live="polite">
          {statusText}
          {progress.note ? ` ${progress.note}` : ''}
        </p>
        {voiceMissing && (
          <p className={panelStyles.description}>
            {t(
              'Your saved voice is no longer installed on this device, so Stapler is reading with {voice} instead.',
              { voice: `${voice.name} (${voice.lang})` }
            )}
          </p>
        )}
      </div>

      <div className={panelStyles.section} style={{ display: 'flex', gap: '8px' }}>
        <IconButton
          icon={ChevronsLeft}
          aria-label={t('Previous page')}
          onClick={() => handlePageStep(-1)}
          disabled={progress.pageIndex === 0}
        />
        <IconButton
          icon={ChevronLeft}
          aria-label={t('Previous sentence')}
          onClick={() => handleSentenceStep(-1)}
          disabled={progress.pageIndex === 0 && progress.sentenceIndex === 0}
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
          aria-label={t('Next sentence')}
          onClick={() => handleSentenceStep(1)}
        />
        <IconButton
          icon={ChevronsRight}
          aria-label={t('Next page')}
          onClick={() => handlePageStep(1)}
          disabled={progress.pageIndex >= doc.pages.length - 1}
        />
      </div>

      {shownText && shownText.sentences.length > 0 && (
        <div className={panelStyles.section}>
          <div
            className={styles.text}
            tabIndex={0}
            role="region"
            aria-label={t('Text being read')}
            lang={voice.lang}
          >
            {shownText.sentences.map((_, index) => (
              <Fragment key={index}>
                {index > 0 ? ' ' : null}
                {renderSentence(index)}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {t(
            'Keys while focus is in this panel: Space plays or pauses, the Left and Right arrows move by sentence, Page Up and Page Down move by page.'
          )}
        </p>
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
                  setReadAloudVoice(uri);
                  restartCurrentSentence();
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
              min={MIN_RATE}
              max={MAX_RATE}
              step={0.05}
              value={readAloudRate.value}
              onChange={rate => {
                setReadAloudRate(rate);
                restartCurrentSentence();
              }}
              ariaLabel={t('Reading speed')}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
