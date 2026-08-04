/**
 * Compression options and the honest projection (CMP-04, CMP-05).
 *
 * The panel analyses before committing, so "already optimized — only N% possible"
 * is shown *before* the work rather than after a minute of processing.
 */
import { Gauge } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, planCompression } from '../../../core/operations';
import { Button } from '../../components/Button';
import { Field, Select, Slider } from '../../components/Field';
import { SizeDelta, formatBytes } from '../../components/Feedback';
import { panelStyles } from '../../shell/OptionsPanel';
import { compressReport, compressSettings } from './state';
import { useEffect } from 'preact/hooks';
import { useJob } from '../../useJob';

const DPI_OPTIONS = [
  { value: 72, label: '72 DPI — smallest' },
  { value: 150, label: '150 DPI — recommended' },
  { value: 300, label: '300 DPI — print' }
] as const;

export function CompressPanel() {
  const doc = activeDoc.value;
  const settings = compressSettings.value;
  const report = compressReport.value;
  const { run } = useJob();
  if (!doc) return null;

  const analyse = () =>
    run({ label: 'Analysing document', scope: 'compress.plan' }, async job => {
      const bytes = await currentDocumentBytes(job);
      compressReport.value = await planCompression(bytes, settings, job);
    });

  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(() => {
      // Re-run projection quietly without a big loading screen for every slider tick
      currentDocumentBytes().then(bytes =>
        planCompression(bytes, settings).then(newReport => {
          compressReport.value = newReport;
        })
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [settings.dpi, settings.quality]);

  const routeCounts = report
    ? report.plan.pages.reduce<Record<string, number>>((counts, page) => {
        counts[page.route] = (counts[page.route] ?? 0) + 1;
        return counts;
      }, {})
    : null;

  return (
    <>
      <Field label="Scanned-page resolution">
        {id => (
          <Select
            id={id}
            value={settings.dpi}
            options={DPI_OPTIONS}
            onChange={dpi => (compressSettings.value = { ...settings, dpi })}
          />
        )}
      </Field>

      <Field label="Image quality" value={`${Math.round(settings.quality * 100)}%`}>
        {id => (
          <Slider
            id={id}
            min={30}
            max={95}
            step={5}
            value={Math.round(settings.quality * 100)}
            scale={['Smaller file', 'Better quality']}
            onChange={value => (compressSettings.value = { ...settings, quality: value / 100 })}
          />
        )}
      </Field>

      <Button variant="secondary" icon={Gauge} onClick={analyse}>
        Analyse without changing anything
      </Button>

      {report && (
        <div className={panelStyles.section}>
          <h3 className={panelStyles.title}>Projection</h3>
          <SizeDelta before={report.originalBytes} after={report.estimatedBytes} />
          <p className={panelStyles.description}>
            Estimated, deliberately cautious. Actual output is measured before saving, and if it is
            not smaller the original is kept.
          </p>

          {routeCounts && (
            <ul className={panelStyles.list}>
              {routeCounts.raster > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>Re-rendered as images (scans)</span>
                  <span>{routeCounts.raster}</span>
                </li>
              )}
              {routeCounts.surgical > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>Images re-encoded, text kept</span>
                  <span>{routeCounts.surgical}</span>
                </li>
              )}
              {routeCounts['already-optimized'] > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>Nothing to gain</span>
                  <span>{routeCounts['already-optimized']}</span>
                </li>
              )}
              {routeCounts.skip > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>Left untouched deliberately</span>
                  <span>{routeCounts.skip}</span>
                </li>
              )}
            </ul>
          )}

          {report.plan.skipped.length > 0 && (
            <p className={panelStyles.note}>
              Not re-encoded, to avoid damaging them: {report.plan.skipped.join('; ')}.
            </p>
          )}

          {report.alreadyOptimized && (
            <p className={panelStyles.note}>
              This document is already optimized — about{' '}
              {Math.max(0, Math.round(report.estimatedFraction * 100))}% is all that is available
              from {formatBytes(report.originalBytes)}. Compressing it is not worth the time.
            </p>
          )}
        </div>
      )}
    </>
  );
}
