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
import { analyseActiveDocument } from './analysis';
import { Button } from '../../components/Button';
import { Field, RadioGroup, Select, Slider } from '../../components/Field';
import { SizeDelta, formatBytes, formatTargetMiss } from '../../components/Feedback';
import { panelStyles } from '../../shell/panelStyles';
import {
  compressColour,
  compressMeasurement,
  compressMode,
  compressReport,
  compressSettings,
  compressTarget,
  compressTargetOutcome,
  lastCompressionResult,
  projectedOutput,
  targetSizeBytes,
  type CompressMode
} from './state';
import { TargetSizeInput } from '../image-size/TargetSizeInput';
import { PDF_TARGET_BOUNDS } from '../../../core/deep-link';
import { MAX_TARGET_TRIALS } from '../../../core/compress-target';
import { useEffect } from 'preact/hooks';
import { useJob } from '../../useJob';
import { fromUnknown, isCancellation, logEvent } from '../../../core/errors';
import { tKey, translate, useTranslation } from '../../../core/i18n';
import type { CompressColour } from '../../../core/compress-gray';
import { withErrorToast } from '../../asyncHandler';

const DPI_OPTIONS = [
  { value: 72, label: tKey('72 DPI — smallest') },
  { value: 150, label: tKey('150 DPI — recommended') },
  { value: 300, label: tKey('300 DPI — print') }
] as const;

const MODE_OPTIONS = [
  {
    value: 'quality' as CompressMode,
    label: tKey('Choose quality'),
    hint: tKey('You pick the resolution and quality; the preview shows the result.')
  },
  {
    value: 'target' as CompressMode,
    label: tKey('Aim for a size'),
    hint: tKey(
      'Stapler tries up to {trials} real settings and reports the size it actually reached.'
    )
  }
] as const;

/**
 * OPS-19 — grey as a compression lever. The two grey hints are the Grayscale
 * tool's own strings: it is the same conversion, so it is described the same way.
 */
const COLOUR_OPTIONS = [
  { value: 'keep' as CompressColour, label: tKey('Keep colour') },
  {
    value: 'gray' as CompressColour,
    label: tKey('Shades of grey'),
    hint: tKey('Every colour becomes the grey of the same brightness.')
  },
  {
    value: 'bw' as CompressColour,
    label: tKey('Black and white'),
    hint: tKey('For scans: pure black on white, usually the smallest file.')
  }
] as const;

export function CompressPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = compressSettings.value;
  const report = compressReport.value;
  const { run } = useJob();

  const analyse = () =>
    run({ label: translate('Analysing document'), scope: 'compress.plan' }, async job => {
      compressReport.value = await analyseActiveDocument(settings, job);
    });

  useEffect(() => {
    if (!report) return;
    const controller = new AbortController();
    const planned = activeDoc.value;
    const timer = setTimeout(() => {
      // Re-run projection quietly without a big loading screen for every slider tick.
      // Aborted when the slider moves again or the panel unmounts, so an older
      // projection can't land after a newer one; dropped if the document or its
      // pages changed meanwhile; and never an unhandled rejection (UI-11).
      void (async () => {
        try {
          const newReport = await analyseActiveDocument(settings, { signal: controller.signal });
          const now = activeDoc.value;
          if (controller.signal.aborted || now?.id !== planned?.id || now?.pages !== planned?.pages)
            return;
          compressReport.value = newReport;
        } catch (err) {
          if (!isCancellation(err))
            logEvent('warn', 'compress.reproject', fromUnknown(err).message);
        }
      })();
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [settings.dpi, settings.quality]);

  // After every hook: returning before `useEffect` made the hook count change
  // between renders with and without a document (AUDIT-2026-10-10 UI30).
  if (!doc) return null;

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
  const colour = compressColour.value;

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
          // `finalBytes` (set once `save()` finishes) reflects password protection
          // applied after compression measured `compressedBytes` — report the size
          // that actually landed on disk, not the pre-encryption one.
          compressedBytes: lastResult.finalBytes ?? lastResult.compressedBytes,
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
          hint: t(option.hint, { trials: MAX_TARGET_TRIALS })
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
              <TargetSizeInput
                id={id}
                value={target}
                bounds={PDF_TARGET_BOUNDS}
                steps={{ KB: 50, MB: 0.5 }}
                dataAttribute="data-target-amount"
                onChange={next => (compressTarget.value = next)}
              />
            )}
          </Field>
          {report && Number.isFinite(targetBytes) && targetBytes >= report.originalBytes && (
            <p className={panelStyles.note}>
              {t(
                'This document is already {size} — smaller than the target, so there is nothing to do.',
                { size: formatBytes(report.originalBytes) }
              )}
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
              ? t('Reached {achieved} — at or under your target of {target}.', {
                  achieved: formatBytes(outcome.achievedBytes),
                  target: formatBytes(outcome.targetBytes)
                })
              : t(
                  'Could not reach {target}. The smallest Stapler can produce without destroying this document is {achieved}.',
                  // Rounded so the miss never reads as the target (IMG-3).
                  formatTargetMiss(outcome.targetBytes, outcome.achievedBytes)
                )}
            {outcome.settings
              ? ` ${t('Settings used: {dpi} DPI, {quality}%.', {
                  dpi: outcome.settings.dpi,
                  quality: Math.round(outcome.settings.quality * 100)
                })} `
              : ' '}
            {t('Attempts: {count}.', { count: outcome.attempts })}
          </p>
          {!outcome.reached && outcome.skipped.length > 0 && (
            <p className={panelStyles.note}>
              {t('Some content cannot be re-encoded safely, so it stays at full size: {items}.', {
                items: outcome.skipped.join('; ')
              })}
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
                options={DPI_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
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
                scale={[t('Smaller file'), t('Better quality')]}
                onChange={value => (compressSettings.value = { ...settings, quality: value / 100 })}
              />
            )}
          </Field>

          <RadioGroup
            legend={t('Colour')}
            name="compress-colour"
            value={colour}
            options={COLOUR_OPTIONS.map(option => ({
              value: option.value,
              label: t(option.label),
              hint: 'hint' in option ? t(option.hint) : undefined
            }))}
            onChange={next => (compressColour.value = next)}
          />
          {colour !== 'keep' && (
            <p className={panelStyles.note} data-compress-colour-note>
              {t(
                'The projection and the preview show compression only, in colour. The converted file is measured before saving. If it is not smaller than the original, the colour-compressed file is saved instead, and if that is not smaller either, the original is kept.'
              )}
            </p>
          )}
        </>
      ) : (
        // In target mode these two are chosen by the search, not by the user, so
        // showing them as editable controls would misrepresent what the export
        // will do. The preview keeps rendering at whatever the search last used.
        <>
          <p className={panelStyles.note}>
            {t(
              'Resolution and quality are chosen by the search. The preview shows {dpi} DPI, {quality}%.',
              { dpi: settings.dpi, quality: Math.round(settings.quality * 100) }
            )}
          </p>
          {colour !== 'keep' && (
            <p className={panelStyles.note} data-compress-colour-note>
              {t(
                'Converting to grey is not used when aiming for a size: each attempt is measured in colour, and converting afterwards would make that measurement untrue. Choose quality to convert while compressing.'
              )}
            </p>
          )}
        </>
      )}

      <Button variant="secondary" icon={Gauge} onClick={() => void analyse()}>
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
              {t('Not re-encoded, to avoid damaging them: {items}.', {
                items: report.plan.skipped.join('; ')
              })}
            </p>
          )}

          {/* "Not worth the time" judges re-encoding alone; with grey on (quality
              mode) a scan can still shrink a lot, and commit does not ask either. */}
          {report.alreadyOptimized && (colour === 'keep' || mode === 'target') && (
            <p className={panelStyles.note}>
              {t(
                'This document is already optimized — about {percent}% is all that is available from {size}. Compressing it is not worth the time.',
                {
                  percent: Math.max(0, Math.round(report.estimatedFraction * 100)),
                  size: formatBytes(report.originalBytes)
                }
              )}
            </p>
          )}

          <Button
            variant="secondary"
            icon={Download}
            onClick={withErrorToast('compress.report', exportReport)}
          >
            {t('Export Report')}
          </Button>
        </div>
      )}
    </>
  );
}
