/**
 * RED-08 — the face/logo blur section of the Redact panel.
 *
 * It lives inside Redact rather than as a tool of its own because it is the
 * same job: taking something out of a document that should not leave with it.
 * It reuses RED-01's marks for the "logo" half so there is one way to draw a
 * rectangle on a page, not two.
 *
 * The copy carries two disclosures the feature cannot ship without: that the
 * detection runs on this device with a bundled model (nothing is downloaded or
 * uploaded); and that a detector misses faces sometimes, so the result needs a
 * look before the document goes anywhere. Neither is buried in a tooltip.
 */
import { useState } from 'preact/hooks';
import { ScanFace } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes } from '../../../core/operations';
import { registerSource, replaceWithSource } from '../../../core/store';
import { writeSourceBytes } from '../../../core/opfs';
import { renderWorker } from '../../../core/workers';
import { notify } from '../../../core/notify';
import { tKey, tPlural, translate, useTranslation } from '../../../core/i18n';
import { runFaceBlur } from '../../../core/faceblur/runFaceBlur';
import type { BlurStrength } from '../../../core/faceblur/blur';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { pendingRedactions } from './state';
import { faceBlurReport, faceBlurSettings } from './faceblur-state';

const STRENGTHS: { value: BlurStrength; label: string }[] = [
  { value: 'light', label: tKey('Light — still recognisable as a person') },
  { value: 'medium', label: tKey('Medium') },
  { value: 'strong', label: tKey('Strong — a few blocks of colour') }
];

const stem = (name: string) => name.replace(/\.pdf$/i, '');

export function FaceBlurSection() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = faceBlurSettings.value;
  const report = faceBlurReport.value;
  const marks = pendingRedactions.value;
  // Own reactive busy flag rather than `useJob`'s `isRunning()`, same as
  // `FontEmbeddingSection`: that reads a plain ref, not a signal, so it never
  // triggers the re-render that would flip the button back on.
  const [busy, setBusy] = useState(false);
  const { run } = useJob();
  if (!doc) return null;

  const update = (patch: Partial<typeof settings>) => {
    faceBlurSettings.value = { ...settings, ...patch };
  };

  const facesEnabled = settings.detectFaces;
  const logoEnabled = settings.useMarkedLogo && marks.length > 0;
  const canRun = facesEnabled || logoEnabled;

  const blur = async () => {
    setBusy(true);
    try {
      await run({ label: translate('Blurring faces'), scope: 'redact.faceblur' }, async job => {
        const original = await currentDocumentBytes(job);
        const result = await runFaceBlur(original, doc.pages.length, {
          ...job,
          detectFaces: facesEnabled,
          strength: settings.strength,
          logoRegion: logoEnabled ? marks[0] : undefined
        });

        faceBlurReport.value = result;

        if (result.imagesChanged === 0) {
          notify('warning', translate('Nothing was blurred.'), {
            detail:
              result.imagesInspected === 0
                ? translate(
                    'These pages hold no embedded images, so there was nothing to look at. Your ' +
                      'document is unchanged.'
                  )
                : tPlural(
                    '{count} images were checked and no face or logo matched. ' +
                      'Your document is unchanged. A small, sideways, or heavily obscured face is the ' +
                      'usual cause — a redaction mark removes it outright.',
                    result.imagesInspected
                  )
          });
          return;
        }

        const source = {
          id: crypto.randomUUID(),
          name: `${stem(doc.name)}-blurred.pdf`,
          pageCount: doc.pages.length,
          pageSizes: [] as { width: number; height: number }[]
        };
        // Geometry comes from the rebuilt bytes, as redaction does. Registered
        // with no sizes, the single-page view rendered nothing and cleanup's
        // "apply to all" threw on `pageSizes[i].width` (AUDIT-2026-09-25 RT-12).
        // pin() keeps load and close on the same render instance.
        const client = renderWorker.pin();
        try {
          const info = await client.lease(api => api.loadDocument(result.bytes));
          source.pageCount = info.pageCount;
          source.pageSizes = info.pageSizes;
          await client.lease(api => api.closeDocument(info.handle));
        } finally {
          client.release();
        }
        await writeSourceBytes(source.id, result.bytes);
        registerSource(source);
        replaceWithSource(doc.id, source);

        notify(
          'success',
          translate('{faces} and {logos} blurred.', {
            faces: tPlural('{count} faces', result.facesBlurred),
            logos: tPlural('{count} logos', result.logosBlurred)
          }),
          {
            detail:
              translate(
                '{images} rewritten across {pages}. ' +
                  'The original pixels are gone from the file, not covered up. Check the result, ' +
                  'then export to save.',
                {
                  images: tPlural('{count} images', result.imagesChanged),
                  pages: tPlural('{count} pages', result.pagesTouched)
                }
              ) +
              (result.skipped.length > 0
                ? ' ' +
                  tPlural(
                    '{count} images could not be checked — see the panel.',
                    result.skipped.length
                  )
                : ''),
            timeout: 0
          }
        );
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Blur faces and logos')}</h2>
      <p className={panelStyles.description}>
        {t(
          'Finds faces in the pictures embedded in this document and replaces those pixels with ' +
            'a coarse mosaic. The original pixels are destroyed inside the file, not hidden ' +
            'behind a shape drawn on top.'
        )}
      </p>

      <Checkbox
        label={t('Blur faces')}
        checked={settings.detectFaces}
        onChange={detectFaces => update({ detectFaces })}
      />

      <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
        {t(
          'The face detector is built into Stapler and runs on this device. Nothing is ' +
            'downloaded, and your images are never uploaded.'
        )}
      </p>

      <Checkbox
        label={t('Also blur the first mark wherever that graphic repeats')}
        checked={settings.useMarkedLogo}
        onChange={useMarkedLogo => update({ useMarkedLogo })}
      />
      {settings.useMarkedLogo && marks.length === 0 && (
        <p className={panelStyles.note}>
          {t(
            'Draw a rectangle around the logo on the page first. It is matched against the other ' +
              'pictures in the document at roughly the same size and orientation — a rotated or ' +
              'recoloured copy will not be found.'
          )}
        </p>
      )}

      <Field label={t('Blur strength')}>
        {id => (
          <Select
            id={id}
            value={settings.strength}
            options={STRENGTHS.map(option => ({
              value: option.value,
              label: t(option.label)
            }))}
            onChange={strength => update({ strength })}
          />
        )}
      </Field>

      <Button
        variant="secondary"
        icon={ScanFace}
        disabled={!canRun || busy}
        onClick={() => void blur()}
      >
        {t('Find and blur')}
      </Button>

      <p className={panelStyles.note}>
        {t(
          'A detector is not a guarantee. Check every page before you share the file: a face ' +
            'that is small, turned away, or partly covered can be missed, and a missed face is ' +
            'not blurred. For something that must not survive at all, use a redaction mark.'
        )}
      </p>

      {report && (
        <div className={panelStyles.section}>
          <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
            {t('Last run: {faces} and {logos} blurred in {images} of {inspected}.', {
              faces: tPlural('{count} faces', report.facesBlurred),
              logos: tPlural('{count} logos', report.logosBlurred),
              images: report.imagesChanged,
              inspected: tPlural('{count} images', report.imagesInspected)
            })}
          </p>
          {report.skipped.length > 0 && (
            <ul className={panelStyles.list} aria-label={t('Images that could not be checked')}>
              {report.skipped.map((skip, index) => (
                <li className={panelStyles.listRow} key={index}>
                  <span className={panelStyles.listRowText}>
                    {t('Page {n} — {reason}', { n: skip.pageIndex + 1, reason: skip.reason })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
