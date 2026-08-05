import { Field } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { normalizeSettings, type NormalizeSettings, type PaperSize, type ScaleMode } from './state';
import styles from './NormalizePanel.module.css';
import { useTranslation } from '../../../core/i18n';

const PAPER_SIZES: { label: string; value: PaperSize }[] = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'US Letter (8.5 × 11 in)', value: 'Letter' },
  { label: 'US Legal (8.5 × 14 in)', value: 'Legal' }
];

const SCALE_MODES: { label: string; value: ScaleMode; hint: string }[] = [
  {
    label: 'Fit',
    value: 'fit',
    hint: 'Scale down to fit within the new size, preserving aspect ratio.'
  },
  { label: 'Fill', value: 'fill', hint: 'Scale up or down to fill the new size. May crop edges.' },
  { label: 'Center', value: 'center', hint: 'Do not scale. Place in the center of the new page.' }
];

export function NormalizePanel() {
  const t = useTranslation();
  // Initialize default state when the panel mounts if it's null
  if (!normalizeSettings.value) {
    normalizeSettings.value = { targetSize: 'A4', scaleMode: 'fit' };
  }

  const settings = normalizeSettings.value;

  return (
    <div className={styles.panel}>
      <p className={panelStyles.description}>
        {t('Resize documents with mixed page sizes to a uniform standard size.')}
      </p>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>{t('Dimensions')}</h3>
        <Field label={t('Target size')}>
          {id => (
            <select
              id={id}
              className={styles.select}
              value={settings?.targetSize || 'A4'}
              onChange={e => {
                normalizeSettings.value = {
                  ...settings,
                  targetSize: e.currentTarget.value as PaperSize
                } as NormalizeSettings;
              }}
            >
              {PAPER_SIZES.map(s => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>{t('Layout')}</h3>
        <Field label={t('Scaling behavior')}>
          {id => (
            <select
              id={id}
              className={styles.select}
              value={settings?.scaleMode || 'fit'}
              onChange={e => {
                normalizeSettings.value = {
                  ...settings,
                  scaleMode: e.currentTarget.value as ScaleMode
                } as NormalizeSettings;
              }}
            >
              {SCALE_MODES.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className={styles.hint}>
          {SCALE_MODES.find(m => m.value === settings?.scaleMode)?.hint}
        </p>
      </div>
    </div>
  );
}
