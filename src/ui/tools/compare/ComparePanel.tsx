import { useState } from 'preact/hooks';
import { Download } from 'lucide-preact';
import { compareSettings } from './state';
import { Button } from '../../components/Button';
import { RadioGroup, Slider, Field } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { platform } from '../../../platform/current';
import { importFiles } from '../../../core/import';
import { logEvent, fromUnknown } from '../../../core/errors';
import { activeJob, notify } from '../../../core/notify';
import { discardImported } from '../../../core/open-document';
import { translate, useTranslation } from '../../../core/i18n';
import {
  activeDoc,
  sources,
  makePageRefs,
  releaseSourceIfUnused,
  type StaplerDoc
} from '../../../core/store';
import { exportComparePdf } from '../../../core/compare-export';
import { useJob } from '../../useJob';

export function ComparePanel() {
  const t = useTranslation();
  const settings = compareSettings.value;
  const { run, isRunning } = useJob();
  const [loading, setLoading] = useState(false);

  const handleOpenCompareFile = async () => {
    // Checked before the picker opens, so a choice is never thrown away (UI-20).
    if (activeJob.value !== null) {
      notify('info', translate('Finish or cancel the current operation first.'));
      return;
    }
    try {
      setLoading(true);
      const files = await platform.openFiles({ accept: { 'application/pdf': ['.pdf'] } });
      if (files.length === 0) return;
      const fileObjects = await Promise.all(files.map(f => f.getFile()));
      // RT-7 — a job with progress and a working Cancel in the action bar.
      await run({ label: translate('Opening document'), scope: 'compare' }, async job => {
        const outcome = await importFiles(fileObjects, job);
        if (job.signal?.aborted) {
          discardImported(outcome);
          return;
        }
        const { imported, failures } = outcome;
        if (imported.length > 0) {
          // Read now, not from the render that started this: the settings may
          // have changed while the file was importing.
          const current = compareSettings.value;
          const previous = current.compareSourceId;
          compareSettings.value = { ...current, compareSourceId: imported[0].source.id };
          if (previous) releaseSourceIfUnused(previous);
          discardImported({ imported: imported.slice(1), failures: [] });
        }
        if (failures.length > 0) {
          logEvent('error', 'compare', failures[0].message);
          notify('danger', translate('Could not open {name}', { name: failures[0].name }), {
            detail: failures[0].message
          });
        }
      });
    } catch (err: unknown) {
      logEvent('error', 'compare', fromUnknown(err).message);
    } finally {
      setLoading(false);
    }
  };

  const exportLabel =
    settings.diffMode === 'text'
      ? t('Exporting text diff')
      : settings.diffMode === 'redline'
        ? t('Exporting redline PDF')
        : t('Exporting visual diff');

  const handleExportDiff = () =>
    run(
      {
        label: exportLabel,
        scope: 'compare'
      },
      async job => {
        const docA = activeDoc.value;
        if (!docA || !settings.compareSourceId) return;

        const compareSource = sources.value[settings.compareSourceId];
        if (!compareSource) return;

        const comparePages = makePageRefs(compareSource.id, compareSource.pageCount);
        const docB: StaplerDoc = {
          id: compareSource.id,
          name: compareSource.name,
          pages: comparePages,
          annotations: [],
          dirty: false,
          baseline: comparePages
        };

        let warning: string | undefined;
        const outBytes = await exportComparePdf(docA, docB, {
          diffMode: settings.diffMode,
          sensitivity: settings.sensitivity,
          unchangedPages: settings.unchangedPages,
          signal: job.signal,
          // X-6 — determinate per-page progress in the action bar.
          onProgress: job.onProgress,
          onWarning: message => {
            warning = message;
          }
        });

        const stem = docA.name.replace(/\.[^.]+$/, '');
        const suffix = settings.diffMode === 'redline' ? 'redline' : 'diff';
        const saved = await platform.saveFileAs(outBytes, `${stem}-${suffix}.pdf`);
        // CONV-13: characters the report's Latin font could not draw are said,
        // not silently turned into "?".
        if (saved && warning) {
          notify('warning', t('PDF saved, but some characters could not be represented.'), {
            detail: warning
          });
        }
      }
    );

  const update = (patch: Partial<typeof settings>) => {
    compareSettings.value = { ...settings, ...patch };
  };

  return (
    <>
      <div className={panelStyles.section}>
        <Button onClick={handleOpenCompareFile} disabled={loading || isRunning()}>
          {settings.compareSourceId ? t('Change comparison file...') : t('Open file to compare...')}
        </Button>
      </div>

      <RadioGroup
        legend={t('Compare Mode')}
        name="diffMode"
        value={settings.diffMode}
        onChange={mode => update({ diffMode: mode as 'visual' | 'text' | 'redline' })}
        options={[
          { value: 'visual', label: t('Visual Pixel Diff'), hint: t('Highlights modified pixels') },
          { value: 'text', label: t('Text Diff'), hint: t('Highlights added and removed text') },
          {
            value: 'redline',
            label: t('Redline (side by side)'),
            hint: t('Before and after pages placed next to each other, print-ready')
          }
        ]}
      />

      {(settings.diffMode === 'visual' || settings.diffMode === 'redline') && (
        <Field label={t('Sensitivity')} value={`${settings.sensitivity}%`}>
          {id => (
            <Slider
              id={id}
              min={0}
              max={100}
              value={settings.sensitivity}
              onChange={v => update({ sensitivity: v })}
            />
          )}
        </Field>
      )}

      {settings.diffMode === 'text' && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('Text diff shows structural text changes. Additions are green, deletions are red.')}
        </p>
      )}

      {settings.diffMode === 'redline' && (
        <RadioGroup
          legend={t('Unchanged pages')}
          name="unchangedPages"
          value={settings.unchangedPages}
          onChange={mode => update({ unchangedPages: mode as 'skip' | 'mark' })}
          options={[
            {
              value: 'mark',
              label: t('Keep, marked "Unchanged"'),
              hint: t('Every page appears in order')
            },
            { value: 'skip', label: t('Skip'), hint: t('Only pages that changed are included') }
          ]}
        />
      )}

      {settings.compareSourceId && (
        <div className={panelStyles.section}>
          <Button
            id="compare-export-diff-btn"
            onClick={handleExportDiff}
            disabled={isRunning() || loading}
            icon={Download}
          >
            {isRunning() ? t('Exporting…') : t('Export Diff PDF')}
          </Button>
        </div>
      )}
    </>
  );
}
