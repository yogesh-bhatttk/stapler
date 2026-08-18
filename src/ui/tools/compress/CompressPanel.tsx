/**
 * Compression options and the honest projection (CMP-04, CMP-05).
 *
 * The panel analyses before committing, so "already optimized — only N% possible"
 * is shown *before* the work rather than after a minute of processing.
 */
import { Download, Gauge } from 'lucide-preact';
import { platform } from '../../../platform/current';
import {
  generateCompressionReportText,
  type CompressionResultStats
} from '../../../core/compress-report';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, planCompression } from '../../../core/operations';
import { Button } from '../../components/Button';
import { Field, NumberInput, RadioGroup, Select, Slider } from '../../components/Field';
import { SizeDelta, formatBytes } from '../../components/Feedback';
import { panelStyles } from '../../shell/OptionsPanel';
import {
  compressMeasurement,
  compressMode,
  compressReport,
  compressSettings,
  compressTarget,
  compressTargetOutcome,
  lastCompressionResult,
  projectedOutput,
  targetSizeBytes,
  type CompressMode,
  type TargetUnit
} from './state';
import { MAX_TARGET_TRIALS } from '../../../core/compress-target';
import { useEffect } from 'preact/hooks';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

const DPI_OPTIONS = [
  { value: 72, label: '72 DPI — smallest' },
  { value: 150, label: '150 DPI — recommended' },
  { value: 300, label: '300 DPI — print' }
] as const;

const MODE_OPTIONS = [
  {
    value: 'quality' as CompressMode,
    label: 'Choose quality',
    hint: 'You pick the resolution and quality; the preview shows the result.'
  },
  {
    value: 'target' as CompressMode,
    label: 'Aim for a size',
    hint: `Stapler tries up to ${MAX_TARGET_TRIALS} real settings and reports the size it actually reached.`
  }
] as const;

const UNIT_OPTIONS = [
  { value: 'MB' as TargetUnit, label: 'MB' },
  { value: 'KB' as TargetUnit, label: 'KB' }
] as const;

export function CompressPanel() {
  const t = useTranslation();
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

  // CMP-05: once the preview has re-encoded the representative page for real,
  // the projection is re-anchored on those measured bytes instead of the
  // pre-flight model. The export path keeps its own pre-flight check.
  const projection = projectedOutput(report, compressMeasurement.value, settings);

  const routeCounts = report
    ? report.plan.pages.reduce<Record<string, number>>((counts, page) => {
        counts[page.route] = (counts[page.route] ?? 0) + 1;
        return counts;
      }, {})
    : null;

  const mode = compressMode.value;
  const target = compressTarget.value;
  const outcome = compressTargetOutcome.value;
  const targetBytes = targetSizeBytes(target);

  const exportReport = async () => {
    if (!report) return;
    // `lastCompressionResult` is set by the commit path, and only by it, so its
    // presence is what distinguishes a finished run from a pre-flight analysis.
    // Without one there is no compressed file, and the report must not print a
    // projection under "Compressed Size:" / "Saved:" as though there were.
    const remembered = lastCompressionResult.value;
    // Compression results are measurements of one particular byte sequence;
    // never attach them to a different document merely because its panel is now
    // open. In that case fall back to this document's clearly-labelled estimate.
    const lastResult = remembered?.documentId === doc.id ? remembered : null;
    const plan = lastResult?.plan ?? report.plan;
    const stats: CompressionResultStats = lastResult
      ? {
          originalBytes: lastResult.originalBytes,
          compressedBytes: lastResult.compressedBytes,
          keptOriginal: lastResult.keptOriginal,
          imageStats: lastResult.imageStats
        }
      : {
          originalBytes: report.originalBytes,
          compressedBytes: projection ? projection.bytes : report.estimatedBytes,
          // Not `alreadyOptimized`: that is a judgement about whether compressing
          // is worth it, not a statement that an output was discarded.
          keptOriginal: false,
          estimated: true
        };
    const text = generateCompressionReportText(plan, stats);
    const stem = doc.name.replace(/\.[^.]+$/, '');
    await platform.saveFileAs(new TextEncoder().encode(text), `${stem}-compression-report.txt`);
  };

  return (
    <>
      <RadioGroup
        legend={t('How should Stapler compress?')}
        name="compress-mode"
        value={mode}
        options={MODE_OPTIONS.map(option => ({
          value: option.value,
          label: t(option.label),
          hint: t(option.hint)
        }))}
        onChange={next => (compressMode.value = next)}
      />

      {mode === 'target' && (
        <>
          <Field
            label={t('Target size')}
            hint={t(
              'Each attempt is a real re-encode, measured on the bytes it produced. If the lowest setting still misses your target, Stapler says so instead of degrading further.'
            )}
          >
            {id => (
              <div className={panelStyles.actions}>
                <NumberInput
                  id={id}
                  min={0.05}
                  step={target.unit === 'MB' ? 0.5 : 50}
                  value={target.amount}
                  data-target-amount={target.amount}
                  onInput={event => {
                    const amount = Number((event.target as HTMLInputElement).value);
                    if (Number.isFinite(amount) && amount > 0) {
                      compressTarget.value = { ...target, amount };
                    }
                  }}
                />
                <Select
                  value={target.unit}
                  options={UNIT_OPTIONS}
                  ariaLabel={t('Target size unit')}
                  onChange={unit => (compressTarget.value = { ...target, unit })}
                />
              </div>
            )}
          </Field>
          {report && targetBytes >= report.originalBytes && (
            <p className={panelStyles.note}>
              {t('This document is already')} {formatBytes(report.originalBytes)} —{' '}
              {t('smaller than the target, so there is nothing to do.')}
            </p>
          )}
        </>
      )}

      {outcome && (
        <div
          className={panelStyles.section}
          data-target-outcome={outcome.reached ? 'reached' : 'missed'}
          data-target-bytes={outcome.targetBytes}
          data-target-achieved={outcome.achievedBytes}
          data-target-attempts={outcome.attempts}
        >
          <h2 className={panelStyles.title}>{t('Target result')}</h2>
          <SizeDelta before={outcome.originalBytes} after={outcome.achievedBytes} />
          <p className={panelStyles.description}>
            {outcome.reached
              ? `${t('Reached')} ${formatBytes(outcome.achievedBytes)} — ${t('at or under your target of')} ${formatBytes(outcome.targetBytes)}.`
              : `${t('Could not reach')} ${formatBytes(outcome.targetBytes)}. ${t('The smallest Stapler can produce without destroying this document is')} ${formatBytes(outcome.achievedBytes)}.`}
            {outcome.settings
              ? ` ${t('Settings used:')} ${outcome.settings.dpi} DPI, ${Math.round(outcome.settings.quality * 100)}%. `
              : ' '}
            {t('Attempts:')} {outcome.attempts}.
          </p>
          {!outcome.reached && outcome.skipped.length > 0 && (
            <p className={panelStyles.note}>
              {t('Some content cannot be re-encoded safely, so it stays at full size:')}{' '}
              {outcome.skipped.join('; ')}.
            </p>
          )}
        </div>
      )}

      {mode === 'quality' ? (
        <>
          <Field label={t('Scanned-page resolution')}>
            {id => (
              <Select
                id={id}
                value={settings.dpi}
                options={DPI_OPTIONS}
                onChange={dpi => (compressSettings.value = { ...settings, dpi })}
              />
            )}
          </Field>

          <Field label={t('Image quality')} value={`${Math.round(settings.quality * 100)}%`}>
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
        </>
      ) : (
        // In target mode these two are chosen by the search, not by the user, so
        // showing them as editable controls would misrepresent what the export
        // will do. The preview keeps rendering at whatever the search last used.
        <p className={panelStyles.note}>
          {t('Resolution and quality are chosen by the search. The preview shows')} {settings.dpi}{' '}
          DPI, {Math.round(settings.quality * 100)}%.
        </p>
      )}

      <Button variant="secondary" icon={Gauge} onClick={analyse}>
        {t('Analyse without changing anything')}
      </Button>

      {report && (
        <div className={panelStyles.section}>
          <h2 className={panelStyles.title}>{t('Projection')}</h2>
          <SizeDelta
            before={report.originalBytes}
            after={projection ? projection.bytes : report.estimatedBytes}
          />
          <p className={panelStyles.description}>
            {projection?.measured
              ? t(
                  'Measured from one page re-encoded at these settings in the preview. Actual output is measured before saving, and if it is not smaller the original is kept.'
                )
              : t(
                  'Estimated, deliberately cautious. Actual output is measured before saving, and if it is not smaller the original is kept.'
                )}
          </p>

          {routeCounts && (
            <ul className={panelStyles.list}>
              {routeCounts.raster > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>
                    {t('Re-rendered as images (scans)')}
                  </span>
                  <span>{routeCounts.raster}</span>
                </li>
              )}
              {routeCounts.surgical > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>
                    {t('Images re-encoded, text kept')}
                  </span>
                  <span>{routeCounts.surgical}</span>
                </li>
              )}
              {routeCounts['already-optimized'] > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>{t('Nothing to gain')}</span>
                  <span>{routeCounts['already-optimized']}</span>
                </li>
              )}
              {routeCounts.skip > 0 && (
                <li className={panelStyles.listRow}>
                  <span className={panelStyles.listRowText}>
                    {t('Left untouched deliberately')}
                  </span>
                  <span>{routeCounts.skip}</span>
                </li>
              )}
            </ul>
          )}

          {report.plan.skipped.length > 0 && (
            <p className={panelStyles.note}>
              {t('Not re-encoded, to avoid damaging them:')} {report.plan.skipped.join('; ')}.
            </p>
          )}

          {report.alreadyOptimized && (
            <p className={panelStyles.note}>
              {t('This document is already optimized — about')}{' '}
              {Math.max(0, Math.round(report.estimatedFraction * 100))}
              {t('% is all that is available from')} {formatBytes(report.originalBytes)}
              {t('. Compressing it is not worth the time.')}
            </p>
          )}

          <Button variant="secondary" icon={Download} onClick={exportReport}>
            {t('Export Report')}
          </Button>
        </div>
      )}
    </>
  );
}
