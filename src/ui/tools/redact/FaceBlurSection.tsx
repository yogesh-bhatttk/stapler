/**
 * RED-08 — the face/logo blur section of the Redact panel.
 *
 * It lives inside Redact rather than as a tool of its own because it is the
 * same job: taking something out of a document that should not leave with it.
 * It reuses RED-01's marks for the "logo" half so there is one way to draw a
 * rectangle on a page, not two.
 *
 * The copy carries two disclosures the feature cannot ship without: that the
 * first face-blur run downloads a model, naming the host and the size; and that
 * a detector misses faces sometimes, so the result needs a look before the
 * document goes anywhere. Neither is buried in a tooltip.
 */
import { useState } from 'preact/hooks';
import { ScanFace } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes } from '../../../core/operations';
import { registerSource, replaceWithSource } from '../../../core/store';
import { writeSourceBytes } from '../../../core/opfs';
import { notify } from '../../../core/notify';
import { translate, useTranslation } from '../../../core/i18n';
import { runFaceBlur } from '../../../core/faceblur/runFaceBlur';
import type { BlurStrength } from '../../../core/faceblur/blur';
import { APPROX_SIZE_MB, MODEL_HOST } from '../../../core/faceblur/model';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { pendingRedactions } from './state';
import { faceBlurModelDeclined, faceBlurReport, faceBlurSettings } from './faceblur-state';

const STRENGTHS: { value: BlurStrength; label: string }[] = [
  { value: 'light', label: 'Light — still recognisable as a person' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong — a few blocks of colour' }
];

const stem = (name: string) => name.replace(/\.pdf$/i, '');

export function FaceBlurSection() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = faceBlurSettings.value;
  const declined = faceBlurModelDeclined.value;
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

  // The face half is off while the download stands declined; the logo half is
  // arithmetic and stays available, which the note below says explicitly.
  const facesEnabled = settings.detectFaces && !declined;
  const logoEnabled = settings.useMarkedLogo && marks.length > 0;
  const canRun = facesEnabled || logoEnabled;

  const blur = async () => {
    setBusy(true);
    try {
      await run({ label: 'Blurring faces', scope: 'redact.faceblur' }, async job => {
        const original = await currentDocumentBytes(job);
        const result = await runFaceBlur(original, doc.pages.length, {
          ...job,
          detectFaces: facesEnabled,
          strength: settings.strength,
          logoRegion: logoEnabled ? marks[0] : undefined
        });

        // `null` is the user declining the model download. That is an answer, not
        // a failure — but it must not be a silent one, so the tool is switched
        // off, the reason stays on screen, and a toast says nothing changed.
        if (!result) {
          faceBlurModelDeclined.value = true;
          notify('warning', translate('Face blur is off — the detector was not downloaded.'), {
            detail:
              'Nothing was changed and nothing was exported. Faces in this document are still ' +
              'visible. Choose "Allow the download" below if you change your mind, or blur a ' +
              'marked logo instead, which needs no model.',
            timeout: 0
          });
          return;
        }

        faceBlurReport.value = result;

        if (result.imagesChanged === 0) {
          notify('warning', translate('Nothing was blurred.'), {
            detail:
              result.imagesInspected === 0
                ? 'These pages hold no embedded images, so there was nothing to look at. Your ' +
                  'document is unchanged.'
                : `${result.imagesInspected} image(s) were checked and no face or logo matched. ` +
                  'Your document is unchanged. A small, sideways, or heavily obscured face is the ' +
                  'usual cause — a redaction mark removes it outright.'
          });
          return;
        }

        const source = {
          id: crypto.randomUUID(),
          name: `${stem(doc.name)}-blurred.pdf`,
          pageCount: doc.pages.length,
          pageSizes: [] as { width: number; height: number }[]
        };
        await writeSourceBytes(source.id, result.bytes);
        registerSource(source);
        replaceWithSource(doc.id, source);

        notify(
          'success',
          translate('{faces} face(s) and {logos} logo(s) blurred.', {
            faces: result.facesBlurred,
            logos: result.logosBlurred
          }),
          {
            detail:
              `${result.imagesChanged} image(s) rewritten across ${result.pagesTouched} page(s). ` +
              'The original pixels are gone from the file, not covered up. Check the result, ' +
              'then export to save.' +
              (result.skipped.length > 0
                ? ` ${result.skipped.length} image(s) could not be checked — see the panel.`
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
        disabled={declined}
        onChange={detectFaces => update({ detectFaces })}
      />

      {declined ? (
        <div className={panelStyles.section}>
          <p className={panelStyles.note}>
            {t(
              'Face blur is switched off because the one-time detector download was declined. ' +
                'Nothing is being blurred, and export will say so. Blurring a marked logo still ' +
                'works — that needs no model.'
            )}
          </p>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              faceBlurModelDeclined.value = false;
              faceBlurSettings.value = { ...settings, detectFaces: true };
            }}
          >
            {t('Allow the download')}
          </Button>
        </div>
      ) : (
        <p className={panelStyles.note + ' ' + panelStyles.noteInfo}>
          {t(
            'The first run downloads a {size} MB detection model from {host}. Stapler asks ' +
              'before it does. After that, face blur needs no network at all, and your images ' +
              'are never uploaded — the detection runs on this device.',
            { size: APPROX_SIZE_MB, host: MODEL_HOST }
          )}
        </p>
      )}

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

      <Button variant="secondary" icon={ScanFace} disabled={!canRun || busy} onClick={blur}>
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
            {t(
              'Last run: {faces} face(s) and {logos} logo(s) blurred in {images} of {inspected} image(s).',
              {
                faces: report.facesBlurred,
                logos: report.logosBlurred,
                images: report.imagesChanged,
                inspected: report.imagesInspected
              }
            )}
          </p>
          {report.skipped.length > 0 && (
            <ul className={panelStyles.list} aria-label={t('Images that could not be checked')}>
              {report.skipped.map((skip, index) => (
                <li className={panelStyles.listRow} key={index}>
                  <span className={panelStyles.listRowText}>
                    {t('Page')} {skip.pageIndex + 1} — {skip.reason}
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
