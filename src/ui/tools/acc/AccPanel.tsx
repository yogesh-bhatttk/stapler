import { activeDoc } from '../../../core/store';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';
import { altTextMap, clearAltText, setAltText } from './state';
import { useJob } from '../../useJob';
import { useEffect, useState } from 'preact/hooks';
import { findImagesForAltText, currentDocumentBytes } from '../../../core/operations';
import { readAltText } from '../../../core/pdf/accessibility';
import type { ImageAltInfo } from '../../../core/workers/process.worker';
import type { JobOptions } from '../../../core/workers/protocol';

export function AccPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const [images, setImages] = useState<(ImageAltInfo & { url: string })[]>([]);
  const { run } = useJob();

  useEffect(() => {
    clearAltText();
    setImages([]);
    if (!doc) return;
    let cancelled = false;
    let activeUrls: string[] = [];
    run({ label: 'Scanning for images...', scope: 'acc' }, async (job: JobOptions) => {
      const bytes = await currentDocumentBytes({ ...job, signal: job.signal }, true);
      const [result, existingAltText] = await Promise.all([
        findImagesForAltText(bytes, { ...job, signal: job.signal }),
        // Alt-text already tagged in the document (by us, on a prior export, or by
        // another tool) — read it back so re-opening a tagged file doesn't show
        // every box blank. Re-key the recovered values by page + image name, the
        // stable label that survives a compose/rebuild cycle.
        readAltText(bytes)
      ]);
      if (job.signal?.aborted || cancelled) return;
      const nextAltText = new Map<string, string>();
      for (const img of result) {
        const existing = existingAltText[`${img.pageIndex}:${img.objectNumber}`];
        if (existing) nextAltText.set(`${img.pageIndex}:${img.name}`, existing);
      }
      altTextMap.value = nextAltText;
      const withUrls = result.map(img => {
        const url = URL.createObjectURL(new Blob([img.bytes], { type: `image/${img.ext}` }));
        activeUrls.push(url);
        return { ...img, url };
      });
      setImages(withUrls);
    });

    return () => {
      cancelled = true;
      // Clean up object URLs when unmounting or doc changes
      activeUrls.forEach(url => URL.revokeObjectURL(url));
      activeUrls = [];
    };
  }, [doc, run]);

  if (!doc) return null;

  return (
    <>
      <p className={panelStyles.description}>
        {t('Attach alt-text to images for PDF/UA accessibility.')}
      </p>

      <div className={panelStyles.section}>
        <h2 className={panelStyles.heading}>{t('Images in Document')}</h2>
        {images.length === 0 ? (
          <p className={panelStyles.note}>{t('Loading images or no images found...')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {images.map(img => {
              const key = `${img.pageIndex}:${img.name}`;
              return (
                <div key={key} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <img
                    src={img.url}
                    alt={`Image on page ${img.pageIndex + 1}`}
                    style={{ width: '80px', height: 'auto', objectFit: 'contain' }}
                  />
                  <div
                    style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '0.25rem' }}
                  >
                    <label
                      htmlFor={`alt-text-${key}`}
                      style={{ fontSize: '11px', color: 'var(--ink-subtle)' }}
                    >
                      Page {img.pageIndex + 1} - {img.name}
                    </label>
                    <input
                      id={`alt-text-${key}`}
                      type="text"
                      className="text-input"
                      style={{ width: '100%', padding: '4px' }}
                      placeholder="Alt text..."
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
