/**
 * UX-03 — the pre-export review step. Reads `exportReviewRequest` (set by
 * `commit.ts`'s `reviewAndSave`/`reviewOnly`) the same way `ConfirmDialog` and
 * `OcrConsentDialog` read their own request signals, and resolves it when the
 * user picks Save or Cancel.
 *
 * 'single' shows a page-by-page before/after `CompareSlider`, with a toggle to
 * paint the pixel-diff mask over the "after" half. 'zip' shows a file list —
 * each member previewed on its own (no before/after: a split's output PDF
 * covers a page range, and extract-img's output is an individual image, so
 * neither pairs 1:1 with an original page the way a whole-document export does).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { unzipSync } from 'fflate';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { exportReviewRequest } from '../../core/notify';
import {
  createPreviewSession,
  diffPage,
  documentPageCount,
  releasePreviewDocument,
  releasePreviewDocuments,
  renderPage,
  type PageDiff,
  type PreviewSession
} from '../../core/diff-preview';
import type { PageAlignment } from '../../core/page-alignment';
import { Modal, requestKey } from './Modal';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { CompareSlider } from './CompareSlider';
import { formatBytes } from './Feedback';
import { Checkbox } from './Field';
import { useTranslation } from '../../core/i18n';
import {
  fastWebViewExport,
  loadExportSettings,
  setFastWebViewExport
} from '../tools/export-settings';
import styles from './ExportReviewModal.module.css';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|tiff?|heic|bmp)$/i;

function DiffCanvas({
  image,
  highlight
}: {
  image: ImageData | null;
  highlight: ImageData | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(image, 0, 0);
    if (highlight) {
      // `pixelDiff` returns red-opaque changed pixels and fully transparent
      // everywhere else, so drawing it straight on top leaves the rest showing.
      const bitmap = document.createElement('canvas');
      bitmap.width = highlight.width;
      bitmap.height = highlight.height;
      const bctx = bitmap.getContext('2d');
      if (bctx) {
        bctx.putImageData(highlight, 0, 0);
        ctx.drawImage(bitmap, 0, 0);
      }
    }
  }, [image, highlight]);
  if (!image) return null;
  return <canvas ref={ref} className={styles.canvas} />;
}

/** A single removed page, rendered alone — reuses the existing after-only render path. */
function RemovedPagePreview({
  session,
  bytes,
  beforeIndex,
  onBack
}: {
  session: PreviewSession;
  bytes: Uint8Array;
  beforeIndex: number;
  onBack: () => void;
}) {
  const t = useTranslation();
  const [image, setImage] = useState<ImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRenderError(false);
    renderPage(session, bytes, beforeIndex)
      .then(result => {
        if (!cancelled) setImage(result);
      })
      .catch(() => {
        if (!cancelled) {
          setImage(null);
          setRenderError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, bytes, beforeIndex]);

  return (
    <div className={styles.body}>
      <div className={styles.toolbar}>
        <span className={styles.pageLabel}>
          {t('Page')} {beforeIndex + 1}
        </span>
        <Button variant="secondary" size="compact" onClick={onBack}>
          {t('Back to review')}
        </Button>
      </div>
      <p className={styles.note}>{t('Removed — will not be in the saved file.')}</p>
      {renderError ? (
        <p className={styles.note}>{t("Couldn't render this page for preview.")}</p>
      ) : (
        <div className={styles.stage} aria-busy={loading}>
          <div
            className={styles.page}
            style={image ? { aspectRatio: `${image.width / image.height}` } : undefined}
          >
            <DiffCanvas image={image} highlight={null} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The summary line and named removed-page chips above the page navigator —
 * hidden entirely when `alignment` shows no structural difference, so a plain
 * crop/watermark-only export looks exactly as it did before this existed.
 */
function AlignmentSummary({
  alignment,
  onViewRemoved
}: {
  alignment: PageAlignment;
  onViewRemoved: (beforeIndex: number) => void;
}) {
  const t = useTranslation();
  const { rotatedCount, movedCount, addedCount } = useMemo(() => {
    let rotated = 0;
    let moved = 0;
    let added = 0;
    for (const entry of alignment.entries) {
      if (entry.beforeIndex === null) added++;
      else {
        if (entry.rotated) rotated++;
        if (entry.moved) moved++;
      }
    }
    return { rotatedCount: rotated, movedCount: moved, addedCount: added };
  }, [alignment]);
  const removedCount = alignment.removedBeforeIndices.length;

  const parts: string[] = [];
  if (rotatedCount > 0) parts.push(t('{count} rotated', { count: rotatedCount }));
  if (movedCount > 0) parts.push(t('{count} reordered', { count: movedCount }));
  if (removedCount > 0) parts.push(t('{count} removed', { count: removedCount }));
  if (addedCount > 0) parts.push(t('{count} added', { count: addedCount }));
  if (parts.length === 0) return null;

  return (
    <div className={styles.summary}>
      <span>{parts.join(' · ')}</span>
      {removedCount > 0 && (
        <div className={styles.removedList}>
          <span>{t('Removed:')}</span>
          {alignment.removedBeforeIndices.map(beforeIndex => (
            <button
              key={beforeIndex}
              type="button"
              className={styles.removedChip}
              onClick={() => onViewRemoved(beforeIndex)}
            >
              {t('page {number}', { number: beforeIndex + 1 })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SinglePageReview({
  session,
  originalBytes,
  resultBytes,
  alignment
}: {
  session: PreviewSession;
  originalBytes: Uint8Array | null;
  resultBytes: Uint8Array;
  alignment?: PageAlignment;
}) {
  const t = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [diff, setDiff] = useState<PageDiff | null>(null);
  const [afterOnly, setAfterOnly] = useState<ImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [highlight, setHighlight] = useState(false);
  const [viewingRemoved, setViewingRemoved] = useState<number | null>(null);
  const [renderError, setRenderError] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    let active = true;
    documentPageCount(session, resultBytes)
      .then(count => {
        if (active) setPageCount(count);
      })
      .catch(() => {
        if (active) setPageCount(null);
      });
    return () => {
      active = false;
    };
  }, [session, resultBytes]);

  const align = alignment?.entries[pageIndex];
  // Falls back to the shared `pageIndex` when there's no alignment — the same
  // positional assumption this always made, for a caller with nothing to align.
  const beforeIndex = align ? align.beforeIndex : pageIndex;

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setRenderError(false);
    (async () => {
      if (originalBytes) {
        const result = await diffPage(
          session,
          originalBytes,
          resultBytes,
          beforeIndex,
          pageIndex,
          align?.afterRotation
        );
        if (requestId.current !== id) return;
        setDiff(result);
        setAfterOnly(null);
      } else {
        const result = await renderPage(session, resultBytes, pageIndex);
        if (requestId.current !== id) return;
        setDiff(null);
        setAfterOnly(result);
      }
    })()
      .catch(() => {
        // A render failure must not leave a blank stage with no explanation
        // and Save still enabled as if the preview succeeded — surface it,
        // rather than silently falling through to whichever half of the pair
        // did resolve.
        if (requestId.current !== id) return;
        setDiff(null);
        setAfterOnly(null);
        setRenderError(true);
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }, [session, originalBytes, resultBytes, beforeIndex, pageIndex, align?.afterRotation]);

  if (viewingRemoved !== null && originalBytes) {
    return (
      <RemovedPagePreview
        session={session}
        bytes={originalBytes}
        beforeIndex={viewingRemoved}
        onBack={() => setViewingRemoved(null)}
      />
    );
  }

  const canPrev = pageIndex > 0;
  // Disabled, not optimistically enabled, while the count is still unknown:
  // letting Next run ahead of it used to push `pageIndex` past the real last
  // page, which made the "after" render come back out of range (`null`) while
  // "before" still resolved fine — and the display fallback then showed that
  // stale "before" image labelled as the review's current page, with nothing
  // saying it wasn't really there.
  const canNext = pageCount !== null && pageIndex < pageCount - 1;

  return (
    <div className={styles.body}>
      {alignment && <AlignmentSummary alignment={alignment} onViewRemoved={setViewingRemoved} />}
      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <IconButton
            icon={ChevronLeft}
            title={t('Previous page')}
            disabled={!canPrev}
            onClick={() => setPageIndex(i => Math.max(0, i - 1))}
          />
          <span className={styles.pageLabel}>
            {pageCount
              ? `${t('Page')} ${pageIndex + 1} / ${pageCount}`
              : `${t('Page')} ${pageIndex + 1}`}
          </span>
          <IconButton
            icon={ChevronRight}
            title={t('Next page')}
            disabled={!canNext}
            onClick={() => setPageIndex(i => i + 1)}
          />
          {align && align.beforeIndex === null && (
            <span className={styles.badge}>{t('New page')}</span>
          )}
          {align?.rotated && <span className={styles.badge}>{t('Rotated')}</span>}
          {align?.moved && (
            <span className={styles.badge}>
              {t('Was page {number}', { number: (align.beforeIndex ?? 0) + 1 })}
            </span>
          )}
        </div>
        {diff?.comparable && (
          <Button
            variant={highlight ? 'primary' : 'secondary'}
            onClick={() => setHighlight(h => !h)}
          >
            {t('Highlight changes')}
          </Button>
        )}
      </div>

      {/* Only for a page that genuinely resized — an added/duplicated page
          (no baseline counterpart at all) hits the same `!comparable` path
          but "changed size" would be a wrong, confusing claim about a page
          that never had a "before" to be a different size from; its "New
          page" badge above is the correct signal instead. */}
      {diff && !diff.comparable && align?.beforeIndex !== null && (
        <p className={styles.note}>
          {t('This page changed size, so before and after cannot be lined up pixel for pixel.')}
        </p>
      )}

      {renderError && (
        <p className={styles.note}>
          {t(
            "Couldn't render this page for preview. This does not necessarily mean the export itself would fail — try another page, or Save to find out."
          )}
        </p>
      )}

      {!renderError &&
        (() => {
          // A page whose size changed (crop, N-up, Normalize) can't share the
          // slider's single overlaid box — the two images are genuinely
          // different shapes, not two versions of one shape. Rendering both,
          // side by side at their own real proportions, is what actually shows
          // a crop or resize happened; discarding "before" and showing only
          // "after" (the previous fallback) left the note as the *only* signal
          // anything changed, easy to miss and impossible to compare against.
          if (diff && !diff.comparable && diff.before && diff.after) {
            return (
              <div className={styles.stage} aria-busy={loading}>
                <div className={styles.sideBySide}>
                  <div className={styles.sidePane}>
                    <span className={styles.sideLabel}>{t('Before')}</span>
                    <div
                      className={styles.sidePage}
                      style={{ aspectRatio: `${diff.before.width / diff.before.height}` }}
                    >
                      <DiffCanvas image={diff.before} highlight={null} />
                    </div>
                  </div>
                  <div className={styles.sidePane}>
                    <span className={styles.sideLabel}>{t('After')}</span>
                    <div
                      className={styles.sidePage}
                      style={{ aspectRatio: `${diff.after.width / diff.after.height}` }}
                    >
                      <DiffCanvas image={diff.after} highlight={null} />
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // The slider's two layers are CSS `position: absolute; width/height:
          // 100%` (CompareSlider.module.css) — that only ever resolves to
          // something visible if *this* box has a real size to be 100% of, which
          // a plain `width/height: auto` div never gives it. An aspect-ratio
          // computed from whichever image is on screen is the same fix
          // `Thumbnail.tsx` already uses for the page grid.
          const shown = afterOnly ?? diff?.after ?? diff?.before ?? null;
          const aspect = shown ? shown.width / shown.height : undefined;
          return (
            <div className={styles.stage} aria-busy={loading}>
              <div
                className={styles.page}
                style={aspect ? { aspectRatio: `${aspect}` } : undefined}
              >
                {diff?.comparable && diff.before && diff.after ? (
                  <CompareSlider
                    label={t('Compare original and result')}
                    before={<DiffCanvas image={diff.before} highlight={null} />}
                    after={
                      <DiffCanvas image={diff.after} highlight={highlight ? diff.diff : null} />
                    }
                  />
                ) : (
                  <DiffCanvas image={shown} highlight={null} />
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

function ZipReview({ session, resultBytes }: { session: PreviewSession; resultBytes: Uint8Array }) {
  const t = useTranslation();
  const [entries] = useState<ZipEntry[]>(() =>
    Object.entries(unzipSync(resultBytes)).map(([name, bytes]) => ({ name, bytes }))
  );
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<
    | { kind: 'image'; url: string }
    | { kind: 'pdf'; image: ImageData | null }
    | { kind: 'error' }
    | null
  >(null);

  useEffect(() => {
    const entry = entries[selected];
    if (!entry) return;
    if (IMAGE_EXT.test(entry.name)) {
      const url = URL.createObjectURL(new Blob([entry.bytes]));
      setPreview({ kind: 'image', url });
      return () => URL.revokeObjectURL(url);
    }
    if (entry.name.toLowerCase().endsWith('.pdf')) {
      let cancelled = false;
      renderPage(session, entry.bytes, 0)
        .then(image => {
          if (!cancelled) setPreview({ kind: 'pdf', image });
        })
        .catch(() => {
          if (!cancelled) setPreview({ kind: 'error' });
        });
      return () => {
        cancelled = true;
        // Only the member on screen stays loaded in the render worker.
        void releasePreviewDocument(session, entry.bytes);
      };
    }
    setPreview(null);
    return undefined;
  }, [session, entries, selected]);

  return (
    <div className={styles.zipLayout}>
      <ul className={styles.fileList}>
        {entries.map((entry, index) => (
          <li key={entry.name}>
            <button
              type="button"
              className={`${styles.fileRow} ${index === selected ? styles.fileRowActive : ''}`}
              onClick={() => setSelected(index)}
              aria-current={index === selected}
            >
              <span className={styles.fileRowName} title={entry.name}>
                {entry.name}
              </span>
              <span className={styles.fileRowSize}>{formatBytes(entry.bytes.byteLength)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.filePreview}>
        {preview?.kind === 'image' && (
          <img className={styles.previewImg} src={preview.url} alt="" />
        )}
        {preview?.kind === 'pdf' && (
          <div
            className={styles.page}
            style={
              preview.image
                ? { aspectRatio: `${preview.image.width / preview.image.height}` }
                : undefined
            }
          >
            <DiffCanvas image={preview.image} highlight={null} />
          </div>
        )}
        {preview?.kind === 'error' && (
          <p className={styles.note}>{t("Couldn't render a preview for this file.")}</p>
        )}
        {!preview && <p className={styles.note}>{t('No preview available for this file type.')}</p>}
      </div>
    </div>
  );
}

/**
 * HRD-23 / DOC-08 — the "Fast web view" export option, shown on every single-PDF
 * review. It is a persisted, export-wide setting (`tools/export-settings.ts`),
 * not a per-review choice, so exports that skip this dialog honour it too; it is
 * offered here because this is the one step those exports reliably pass through.
 * A plain checkbox: reachable by Tab, toggled with Space, labelled.
 */
function FastWebViewOption() {
  const t = useTranslation();
  useEffect(() => {
    void loadExportSettings();
  }, []);
  const on = fastWebViewExport.value;
  return (
    <div className={styles.exportOptions}>
      <Checkbox label={t('Fast web view')} checked={on} onChange={setFastWebViewExport} />
      <p className={styles.note}>
        {on
          ? t(
              'Page 1 is saved first, so a browser can show it before the rest of the file has loaded. The file is usually a little larger. Applies to every PDF you save.'
            )
          : t(
              'Saves the smallest file. Turn on to put page 1 first, so a browser can show it before the rest of the file has loaded.'
            )}
      </p>
    </div>
  );
}

export const ExportReviewModal = forwardRef<HTMLDivElement, Record<string, never>>(
  function ExportReviewModal(_props, ref) {
    const t = useTranslation();
    const request = exportReviewRequest.value;
    // The previews keep each document loaded in the render worker for the
    // length of one review; close them when that review ends or is replaced.
    // The cache is this review's own (R-PDF-3): releasing it can never close
    // documents a replacement review has already started loading.
    const session = useMemo(() => (request ? createPreviewSession() : null), [request]);
    useEffect(() => {
      if (!session) return;
      return () => void releasePreviewDocuments(session);
    }, [session]);
    if (!request || !session) return null;

    return (
      <Modal
        key={requestKey(request)}
        ref={ref}
        title={t('Review before saving')}
        size="lg"
        onClose={() => request.resolve(false)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => request.resolve(false)}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => request.resolve(true)}>
              {t('Save {name}', { name: request.fileName })}
            </Button>
          </>
        }
      >
        {request.kind === 'zip' ? (
          <ZipReview session={session} resultBytes={request.resultBytes} />
        ) : (
          <SinglePageReview
            session={session}
            originalBytes={request.originalBytes}
            resultBytes={request.resultBytes}
            alignment={request.alignment}
          />
        )}
        {request.kind === 'single' && /\.pdf$/i.test(request.fileName) && <FastWebViewOption />}
      </Modal>
    );
  }
);
