/**
 * CNV-09/11/13 — the panel state the three conversions *into* PDF share.
 *
 * The mirror of `pdf-source-state.ts`, and deliberately a second factory rather
 * than one generalised over both: these three do not convert the open document
 * at all. Their input is a file picked from disk, so their state is a different
 * shape (a `File` and an input revision, no document id) and their staleness
 * rule is a different rule.
 *
 * **Which staleness rule, and why.** CNV-08, CNV-10 and CNV-12 convert the *open
 * document*, so their checks key on the document id plus `history.ts`'s
 * `historyVersion`, because editing a page leaves the id unchanged. Here the
 * workspace document is not the input at all — `historyVersion` says nothing
 * about whether the preview is still valid, and gating on it would re-close the
 * gate on an unrelated edit. The equivalent is an *input revision*: a counter
 * every change to the chosen file or to an option bumps, checked alongside the
 * `File` object's own identity rather than instead of it, because re-picking a
 * different file that happens to have the same name would otherwise look
 * unchanged.
 *
 * The produced PDF is held here rather than a "has previewed" flag, for the same
 * reason its siblings do it: the bytes the action bar writes are the exact bytes
 * the preview was rendered from, so the two cannot describe different documents.
 */
import { signal, type Signal } from '@preact/signals';
import type { ToolId } from '../../../core/tools';
import { setCommitGate } from '../commit-gate';

/** One tool's slice of state. Every field is re-exported under the tool's own name. */
export interface OfficeSourceState<Options, Result> {
  options: Signal<Options>;
  /** The chosen file, held as the `File` so the bytes are read at convert time. */
  source: Signal<File | null>;
  /**
   * Bumped by every change to the input: a different file, or a different option.
   *
   * Captured *before* the file's bytes are read, not when the result comes back,
   * so a change made while the conversion is still running invalidates it too —
   * the same ordering CNV-08's second audit pass established for `historyVersion`.
   */
  inputRevision: Signal<number>;
  /** The finished conversion, or null when nothing has been previewed yet. */
  preview: Signal<Result | null>;
  /** The exact `File` the held bytes were converted from. */
  previewSource: Signal<File | null>;
  /** The input revision the conversion's *input bytes* were read at. */
  previewRevision: Signal<number | null>;
  /** Chooses (or clears) the source file. Always throws any preview away. */
  setSource(file: File | null): void;
  /**
   * Changes an option. The previewed PDF was laid out under the old one, so it
   * is no longer what the panel is describing.
   */
  setOptions(options: Options): void;
  setPreview(result: Result | null, file: File | null, revision?: number | null): void;
  /** Drops the preview without touching the chosen file. */
  resetPreview(): void;
  /**
   * True when the held bytes no longer describe the input as it stands — no
   * file, a different file, or the same file with an option changed since. Read
   * by the panel (to close the gate) and by `commit.ts`'s handler, which refuses
   * again regardless, because a disabled button is a courtesy and the handler's
   * check is the guarantee.
   *
   * A missing revision counts as stale: the only way one is absent while a
   * preview is held is a caller that did not record it, and refusing to save is
   * the safe side of that mistake.
   */
  isStale(): boolean;
}

export function createOfficeSourceState<Options, Result>(
  tool: ToolId,
  gates: {
    /** Shown once a file is chosen but no preview has been produced. */
    preview: string;
    /** Shown while no file has been chosen at all. */
    noFile: string;
  },
  defaultOptions: Options
): OfficeSourceState<Options, Result> {
  const options = signal<Options>(defaultOptions);
  const source = signal<File | null>(null);
  const inputRevision = signal(0);
  const preview = signal<Result | null>(null);
  const previewSource = signal<File | null>(null);
  const previewRevision = signal<number | null>(null);

  const isStale = (): boolean => {
    if (preview.value === null) return true;
    if (source.value === null) return true;
    if (previewSource.value !== source.value) return true;
    return previewRevision.value !== inputRevision.value;
  };

  // Every mutator below ends here, so the gate can never be left describing a
  // state the signals have already moved past. Unlike the PDF-source family this
  // needs no `effect`: nothing outside this module can change the input.
  const refreshGate = (): void => {
    if (!isStale()) {
      setCommitGate(tool, null);
      return;
    }
    setCommitGate(tool, source.value ? gates.preview : gates.noFile);
  };

  const clearPreview = (): void => {
    preview.value = null;
    previewSource.value = null;
    previewRevision.value = null;
  };

  const setPreview = (
    result: Result | null,
    file: File | null,
    revision: number | null = null
  ): void => {
    preview.value = result;
    previewSource.value = result ? file : null;
    previewRevision.value = result ? revision : null;
    refreshGate();
  };

  /** The gate starts closed, before the panel has ever mounted. */
  setCommitGate(tool, gates.noFile);

  return {
    options,
    source,
    inputRevision,
    preview,
    previewSource,
    previewRevision,
    setSource(file) {
      source.value = file;
      inputRevision.value += 1;
      clearPreview();
      refreshGate();
    },
    setOptions(next) {
      options.value = next;
      inputRevision.value += 1;
      clearPreview();
      refreshGate();
    },
    setPreview,
    // Plain functions, not methods: every tool module re-exports these as bare
    // functions, and a `this`-dependent one would break there.
    resetPreview: () => setPreview(null, null, null),
    isStale
  };
}
