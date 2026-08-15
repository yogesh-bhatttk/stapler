/**
 * Scan-cleanup options (SCN-02, SCN-03).
 */
import { cleanupSettings, isDetectingCorners } from './state';
import { Checkbox, Field, RadioGroup, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import type { Preset } from '../../../core/cv/enhance';
import { useTranslation } from '../../../core/i18n';

export function CleanupPanel() {
  const t = useTranslation();
  const settings = cleanupSettings.value;
  const manual = settings.preset === 'photo' || settings.preset === 'original';
  const update = (patch: Partial<typeof settings>) => {
    cleanupSettings.value = { ...settings, ...patch };
  };

  return (
    <>
      <RadioGroup<Preset>
        legend={t('Preset')}
        name="cleanupPreset"
        value={settings.preset}
        onChange={preset =>
          // Thresholding destroys a colour photograph, so switching to Photo also
          // turns off deskew, which would crop the subject.
          update({ preset, deskew: preset === 'auto' || preset === 'bw' })
        }
        options={[
          { value: 'auto', label: 'Auto', hint: 'Adaptive threshold, gentle' },
          { value: 'bw', label: 'B&W document', hint: 'Pure white paper, solid black text' },
          { value: 'photo', label: 'Photo / colour', hint: 'Tone only — never thresholded' },
          { value: 'original', label: 'Manual', hint: 'Just the sliders below' }
        ]}
      />

      <Checkbox
        label={t('Straighten automatically')}
        checked={settings.deskew}
        onChange={deskew => update({ deskew })}
      />

      <Checkbox
        label={t('Flatten background')}
        checked={settings.flattenBackground}
        onChange={flattenBackground => update({ flattenBackground })}
      />
      {settings.flattenBackground && (
        <Field label={t('Background color')}>
          {id => (
            <input
              id={id}
              type="color"
              value={settings.flattenTint}
              onChange={event => update({ flattenTint: (event.target as HTMLInputElement).value })}
              style={{ width: '100%', height: '32px', padding: '0', cursor: 'pointer' }}
            />
          )}
        </Field>
      )}

      <Checkbox
        label={t('Despeckle (remove noise)')}
        checked={settings.despeckle}
        disabled={manual}
        onChange={despeckle => update({ despeckle })}
      />

      <Field label={t('Contrast')} value={String(settings.contrast)}>
        {id => (
          <Slider
            id={id}
            min={-100}
            max={100}
            value={settings.contrast}
            disabled={!manual}
            onChange={contrast => update({ contrast })}
          />
        )}
      </Field>

      <Field label={t('Brightness')} value={String(settings.brightness)}>
        {id => (
          <Slider
            id={id}
            min={-100}
            max={100}
            value={settings.brightness}
            disabled={!manual}
            onChange={brightness => update({ brightness })}
          />
        )}
      </Field>

      {!manual && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t(
            'The Auto and B&W presets set contrast per pixel, so the sliders do not apply. Switch to Photo or Manual to use them.'
          )}
        </p>
      )}

      {isDetectingCorners.value && (
        <p className={panelStyles.description}>{t('Finding the page edges…')}</p>
      )}

      <p className={panelStyles.description}>
        {t(
          'Drag the corner handles on the page to correct the detected edges. Apply writes the cleaned page back into the document.'
        )}
      </p>
    </>
  );
}
