import { activeDoc } from '../../../core/store';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';
import { altTextMap, clearAltText, setAltText } from './state';
import { fromUnknown, isCancellation, logEvent } from '../../../core/errors';
import { useEffect, useState } from 'preact/hooks';
import { findImagesForAltText, currentDocumentBytes } from '../../../core/operations';
import { readAltText } from '../../../core/pdf/accessibility';
import type { ImageAltInfo } from '../../../core/workers/process.worker';
import type { JobOptions } from '../../../core/workers/protocol';

type ScanStatus = 'loading' | 'ready' | 'error';

export function AccPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const [images, setImages] = useState<(ImageAltInfo & { url: string })[]>([]);
  const [status, setStatus] = useState<ScanStatus>('loading');

  // Typed alt text belongs to a document, so it is dropped only when the
  // document changes — not on every rotate or reorder (the old effect cleared
  // it on any edit, discarding what the user had typed).
  useEffect(() => {
    clearAltText();
  }, [doc?.id]);

  // A background scan with its own controller rather than a `useJob` job: it
  // is not something the user started, so it must not hold the app-wide job
  // slot. It did, and a scan still running when the page list changed kept
  // the slot, so the re-scan was refused and the panel sat on "Loading…"
  // forever (AUDIT-2026-09-25 UI-18). Re-runs per document revision only.
  useEffect(() => {
    if (!doc) return;
    const controller = new AbortController();
    const urls: string[] = [];
    setStatus('loading');
    setImages([]);

    void (async () => {
      try {
        const job: JobOptions = { signal: controller.signal };
        const bytes = await currentDocumentBytes(job, true);
        const [result, existingAltText] = await Promise.all([
          findImagesForAltText(bytes, job),
          // Alt-text already tagged in the document (by us, on a prior export, or by
          // another tool) — read it back so re-opening a tagged file doesn't show
          // every box blank. Re-key the recovered values by page + image name, the
          // stable label that survives a compose/rebuild cycle.
          readAltText(bytes)
        ]);
        if (controller.signal.aborted) return;
        const nextAltText = new Map<string, string>();
        for (const img of result) {
          const key = `${img.pageIndex}:${img.name}`;
          // What the user typed this session wins over what the file carries.
          const typed = altTextMap.value.get(key);
          const existing = existingAltText[`${img.pageIndex}:${img.objectNumber}`];
          if (typed !== undefined) nextAltText.set(key, typed);
          else if (existing) nextAltText.set(key, existing);
        }
        altTextMap.value = nextAltText;
        const withUrls = result.map(img => {
          const url = URL.createObjectURL(new Blob([img.bytes], { type: `image/${img.ext}` }));
          urls.push(url);
          return { ...img, url };
        });
        setImages(withUrls);
        setStatus('ready');
      } catch (err) {
        if (controller.signal.aborted || isCancellation(err)) return;
        logEvent('warn', 'acc.scan', fromUnknown(err).message);
        setStatus('error');
      }
    })();

    return () => {
      controller.abort();
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [doc?.id, doc?.pages]);

  if (!doc) return null;

  return (
    <>
      <p className={panelStyles.description}>
        {t('Attach alt-text to images for PDF/UA accessibility.')}
      </p>

      <div className={panelStyles.section}>
        <h2 className={panelStyles.heading}>{t('Images in Document')}</h2>
        {status === 'loading' ? (
          <p className={`${panelStyles.note} ${panelStyles.noteInfo}`} role="status">
            {t('Looking for images…')}
          </p>
        ) : status === 'error' ? (
          <p className={panelStyles.note} role="alert">
            {t('The images in this document could not be read.')}
          </p>
        ) : images.length === 0 ? (
          <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
            {t('This document has no images to describe.')}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {images.map(img => {
              const key = `${img.pageIndex}:${img.name}`;
              return (
                <div key={key} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <img
                    src={img.url}
                    alt={t('Image on page {page}', { page: img.pageIndex + 1 })}
                    style={{ width: '80px', height: 'auto', objectFit: 'contain' }}
                  />
                  <div
                    style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '0.25rem' }}
                  >
                    <label
                      htmlFor={`alt-text-${key}`}
                      style={{ fontSize: '11px', color: 'var(--ink-subtle)' }}
                    >
                      {t('Page {page} - {name}', { page: img.pageIndex + 1, name: img.name })}
                    </label>
                    <input
                      id={`alt-text-${key}`}
                      type="text"
                      className="text-input"
                      style={{ width: '100%', padding: '4px' }}
                      placeholder={t('Alt text...')}
                      value={altTextMap.value.get(key) ?? ''}
                      onChange={e => setAltText(key, e.currentTarget.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
