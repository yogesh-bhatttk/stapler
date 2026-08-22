/**
 * SCN-04 — scans every page for barcodes/QR codes and lists what was found.
 *
 * "Extractable metadata" per the ticket, so it lives beside the other
 * document-facts sections in this panel (font embedding, signature
 * integrity) rather than in the Scan cleanup tool: cleanup edits a page,
 * this only reads one. The render call it scans is the same one Scan
 * cleanup's own preview renders through (`renderWorker`'s page render), not
 * a second rendering path — "reusing SCN-01/02's rendering pipeline" is
 * about that shared call, not about running the deskew/threshold step
 * first, which a barcode decoder does not need: it already tolerates
 * moderate rotation and noise on its own.
 */
import { useState } from 'preact/hooks';
import { ScanBarcode, Download } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import {
  currentDocumentBytes,
  scanDocumentBarcodes,
  type PageBarcodes
} from '../../../core/operations';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

export function BarcodeScanSection() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const [results, setResults] = useState<PageBarcodes[] | null>(null);
  // See FontEmbeddingSection's comment on why this is a local useState rather
  // than useJob's isRunning(): a component that also calls a local setter
  // (setResults) inside the job callback needs its own reactive busy flag.
  const [busy, setBusy] = useState(false);
  const { run, isRunning } = useJob();
  if (!doc) return null;

  const scan = async () => {
    setBusy(true);
    try {
      await run({ label: 'Scanning for barcodes', scope: 'barcodes.scan' }, async job => {
        const bytes = await currentDocumentBytes(job);
        const pageIndices = doc.pages.map((_, index) => index);
        const scanned = await scanDocumentBarcodes(bytes, pageIndices, job);
        setResults(scanned.filter(page => page.barcodes.length > 0 || page.reason));
      });
    } finally {
      setBusy(false);
    }
  };

  const exportList = async () => {
    if (!results || results.length === 0) return;
    const lines = results.flatMap(page =>
      page.barcodes.map(code => `Page ${page.pageIndex + 1}\t${code.format}\t${code.text}`)
    );
    const bytes = new TextEncoder().encode(['Page\tFormat\tValue', ...lines].join('\n'));
    await platform.saveFileAs(bytes, 'barcodes.txt');
  };

  const totalFound = results?.reduce((n, page) => n + page.barcodes.length, 0) ?? 0;

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Barcodes')}</h2>
      <p className={panelStyles.description}>
        {t('Scans every page for QR codes and 1D barcodes, on-device.')}
      </p>
      <Button variant="secondary" icon={ScanBarcode} onClick={scan} disabled={busy || isRunning()}>
        {t('Scan for barcodes')}
      </Button>

      {results && results.length === 0 && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('No barcodes found on any page.')}
        </p>
      )}

      {results && results.length > 0 && (
        <>
          <ul className={panelStyles.list}>
            {results.flatMap(page => [
              ...page.barcodes.map((code, i) => (
                <li className={panelStyles.listRow} key={`${page.pageIndex}-${i}`}>
                  <span className={panelStyles.listRowText} title={code.text}>
                    {t('Page {page}', { page: page.pageIndex + 1 })} — {code.format}: {code.text}
                  </span>
                </li>
              )),
              // "Could not be checked" is a different fact from "checked, found
              // nothing" — a page that failed to render must never look the
              // same as one that was scanned and came back barcode-free.
              ...(page.reason
                ? [
                    <li className={panelStyles.listRow} key={`${page.pageIndex}-reason`}>
                      <span className={panelStyles.listRowText} title={page.reason}>
                        {t('Page {page}', { page: page.pageIndex + 1 })} —{' '}
                        {t('could not be checked')}
                      </span>
                    </li>
                  ]
                : [])
            ])}
          </ul>
          <Button size="compact" variant="tertiary" icon={Download} onClick={exportList}>
            {t('Export {count} as a list', { count: totalFound })}
          </Button>
        </>
      )}
    </div>
  );
}
