/**
 * ACC-03 — reflow view: renders a page's extracted text as large, single-column,
 * resizable-font prose instead of the page image. Purely presentational — this
 * component never mutates the document, and `reflow`'s commit handler is a no-op.
 *
 * Known limitation, disclosed rather than guessed at: reading order comes from
 * `extractPageText` (the same `layoutText` CNV-04's Extract Text tool already
 * ships), which groups runs into lines top-to-bottom and sorts each line
 * left-to-right — correct for ordinary single-column pages, but a genuine
 * multi-column layout is read straight across both columns on each line rather
 * than column by column. Column-aware reordering is not implemented here.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import type { PageRef } from '../../../core/store';
import { currentDocumentBytes, extractPageText } from '../../../core/operations';
import { Button } from '../../components/Button';
import singlePageStyles from '../../shell/SinglePageView.module.css';
import styles from './ReflowView.module.css';
import { useTranslation } from '../../../core/i18n';
import { reflowFontSize } from './state';
import { pageListKey } from '../../../core/page-version';
import { logEvent } from '../../../core/errors';

export interface ReflowViewProps {
  docId: string;
  pages: PageRef[];
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
}

export function ReflowView({ docId, pages, pageIndex, onPageIndexChange }: ReflowViewProps) {
  const t = useTranslation();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [paragraphs, setParagraphs] = useState<string[] | null>(null);
  // X-11 — a failed byte build or text extraction shows a message instead of
  // "Reading…" for ever.
  const [failed, setFailed] = useState(false);
  // X-11 — keyed on the page list, not just the document id: after a page
  // is deleted or moved, the cached bytes would show another page's text.
  const docKey = pageListKey({ id: docId, pages });
  const bytesKey = useRef<string | null>(null);

  useEffect(() => {
    if (bytesKey.current === docKey) return;
    bytesKey.current = docKey;
    setBytes(null);
    setParagraphs(null);
    setFailed(false);
    // Without this, a slower stale fetch for a document switched away from
    // can resolve after a faster one for the document switched *to*, and
    // silently overwrite its already-loaded, correct bytes with the wrong
    // document's.
    let cancelled = false;
    currentDocumentBytes()
      .then(loaded => {
        if (!cancelled) setBytes(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logEvent('warn', 'reflow.bytes', String(err));
        setFailed(true);
      });
    return () => {
      cancelled = true;
      // Superseded before it landed: let the next run fetch afresh.
      if (bytesKey.current === docKey) bytesKey.current = null;
    };
  }, [docKey]);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    setParagraphs(null);
    setFailed(false);
    extractPageText(bytes, pageIndex, 'text')
      .then(text => {
        if (cancelled) return;
        const parts = text
          .split(/\n{2,}/)
          .map(p => p.replace(/\n/g, ' ').trim())
          .filter(Boolean);
        setParagraphs(parts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logEvent('warn', 'reflow.text', String(err));
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, pageIndex]);

  return (
    <div className={singlePageStyles.wrapper}>
      <div className={styles.stage} tabIndex={0} aria-label={t('Reflowed page text, scrollable')}>
        <div className={styles.page} style={{ fontSize: `${reflowFontSize.value}px` }}>
          {failed ? (
            <p className={styles.status} role="alert">
              {t('The text of this page could not be read.')}
            </p>
          ) : paragraphs === null ? (
            <p className={styles.status}>{t('Reading…')}</p>
          ) : paragraphs.length === 0 ? (
            <p className={styles.status}>{t('This page has no extractable text.')}</p>
          ) : (
            paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)
          )}
        </div>
      </div>

      <div className={singlePageStyles.pager}>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronLeft}
          disabled={pageIndex === 0}
          onClick={() => onPageIndexChange(pageIndex - 1)}
        >
          {t('Previous')}
        </Button>
        <span className={singlePageStyles.pagerLabel}>
          {t('Page')} {pageIndex + 1} {t('of')} {pages.length}
        </span>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronRight}
          iconPosition="right"
          disabled={pageIndex >= pages.length - 1}
          onClick={() => onPageIndexChange(pageIndex + 1)}
        >
          {t('Next')}
        </Button>
      </div>
    </div>
  );
}
