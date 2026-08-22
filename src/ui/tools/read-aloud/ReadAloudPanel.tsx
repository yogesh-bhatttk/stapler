/**
 * ACC-02 — read the document's extracted text aloud via the Web Speech
 * Synthesis API. Every voice it can use is on-device (the OS's or browser's
 * own), so this never fetches anything — same invariant as everything else here,
 * just enforced by what the API is capable of rather than by a check.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, Pause, Play, Square } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, extractPageText } from '../../../core/operations';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Field, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import { readAloudProgress, readAloudRate } from './state';

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function ReadAloudPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const { run } = useJob();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const bytesDocId = useRef<string | null>(null);
  const currentUtterance = useRef<SpeechSynthesisUtterance | null>(null);
  const progress = readAloudProgress.value;

  // Leaving the tool (or the document changing) must not leave audio playing
  // over whatever the user looks at next.
  useEffect(
    () => () => {
      if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
    },
    []
  );
  useEffect(() => {
    if (bytesDocId.current !== (doc?.id ?? null)) {
      setBytes(null);
      bytesDocId.current = doc?.id ?? null;
      if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
      readAloudProgress.value = { status: 'idle', pageIndex: 0, note: null };
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

  const ensureBytes = async (): Promise<Uint8Array | null> => {
    if (bytes) return bytes;
    const fetched = await run({ label: 'Preparing text', scope: 'read-aloud.prepare' }, job =>
      currentDocumentBytes(job)
    );
    if (fetched) setBytes(fetched);
    return fetched ?? null;
  };

  const speakPage = async (pageIndex: number, currentBytes: Uint8Array) => {
    const layout = await extractPageText(currentBytes, pageIndex, 'text');
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
    utterance.rate = readAloudRate.value;
    currentUtterance.current = utterance;
    utterance.onend = () => {
      // A stale utterance's `onend` can still fire after Stop or after the user
      // has already moved to a different page by hand — only auto-advance if
      // this is still the page actually in flight. Status and page number
      // alone are not enough: restarting the *same* page at a new speed
      // (below) cancels the old utterance and speaks a new one without
      // touching either, and Chrome fires `onend` — not `onerror` — for the
      // one `cancel()` merely interrupted. Only the utterance that is still
      // the current one actually reached the end of its text.
      if (currentUtterance.current !== utterance) return;
      if (
        readAloudProgress.value.status === 'playing' &&
        readAloudProgress.value.pageIndex === pageIndex
      ) {
        goToPage(pageIndex + 1, currentBytes);
      }
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const goToPage = (pageIndex: number, currentBytes: Uint8Array) => {
    if (pageIndex < 0) return;
    if (pageIndex >= doc.pages.length) {
      window.speechSynthesis.cancel();
      readAloudProgress.value = { status: 'idle', pageIndex: doc.pages.length - 1, note: null };
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
    window.speechSynthesis.cancel();
    readAloudProgress.value = { status: 'idle', pageIndex: progress.pageIndex, note: null };
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
