/**
 * UI-15 — which speech request, if any, is still allowed to act.
 *
 * Read-aloud kept going page after page after the user left the tool. Two
 * holes, both closed here:
 *
 *  • Leaving called `speechSynthesis.cancel()` while the status was still
 *    `playing` and the utterance still current. Chrome answers `cancel()` with
 *    `onend` — not `onerror` — so the handler saw "current utterance finished
 *    while playing" and advanced to the next page, on a panel no longer on
 *    screen. {@link SpeechSession.stop} now drops the utterance and marks the
 *    status idle *before* cancelling.
 *  • `speakPage` awaits the page's text before speaking. A Stop, a page step,
 *    or leaving the tool during that await did not stop the late `speak()`.
 *    Each request now takes a token from {@link SpeechSession.begin}, and only
 *    the latest, on a live panel, may speak.
 */

/** The slice of `window.speechSynthesis` a session drives. */
export interface SpeechSynthLike {
  cancel(): void;
  speak(utterance: SpeechSynthesisUtterance): void;
}

export class SpeechSession {
  private token = 0;
  private disposed = false;
  private current: SpeechSynthesisUtterance | null = null;

  /** Starts a speak request, superseding any still in flight. */
  begin(): number {
    this.token += 1;
    return this.token;
  }

  /** Whether request `token` may still act: not superseded, stopped, or unmounted. */
  isLive(token: number): boolean {
    return !this.disposed && token === this.token;
  }

  /**
   * Speaks `utterance` for request `token` if it is still live; returns
   * whether it did. The new utterance becomes current *before* the old one is
   * cancelled, so the old one's `onend` (which `cancel()` fires) is ignored.
   */
  speak(synth: SpeechSynthLike, token: number, utterance: SpeechSynthesisUtterance): boolean {
    if (!this.isLive(token)) return false;
    this.current = utterance;
    synth.cancel();
    synth.speak(utterance);
    return true;
  }

  /**
   * For an utterance's `onend`: true only when it is still the one in flight,
   * i.e. it reached the end of its text rather than being cancelled, replaced
   * or orphaned by the panel unmounting.
   */
  finished(utterance: SpeechSynthesisUtterance): boolean {
    return !this.disposed && this.current === utterance;
  }

  /** Stops speaking: invalidates every request, marks idle, *then* cancels. */
  stop(synth: SpeechSynthLike | null, markIdle: () => void): void {
    this.token += 1;
    this.current = null;
    markIdle();
    synth?.cancel();
  }

  /** The panel is going away: stop, and refuse every later request. */
  dispose(synth: SpeechSynthLike | null, markIdle: () => void): void {
    this.disposed = true;
    this.stop(synth, markIdle);
  }
}
