import { useEffect } from 'preact/hooks';
import { Field } from '../../components/Field';
import { nupSettings, type NUpLayout } from './state';
import styles from './NUpPanel.module.css';
import { tKey, useTranslation } from '../../../core/i18n';

const LAYOUTS: { value: NUpLayout; label: string }[] = [
  { value: '2-up', label: tKey('2-up') },
  { value: '4-up', label: tKey('4-up') },
  { value: 'booklet', label: tKey('Booklet') }
];

export function NUpPanel() {
  const t = useTranslation();
  useEffect(() => {
    if (!nupSettings.value) {
      nupSettings.value = {
        layout: '2-up',
        margin: 10,
        gutter: 10,
        drawBorders: false
      };
    }
    return () => {
      nupSettings.value = null;
    };
  }, []);

  const settings = nupSettings.value;
  if (!settings) return null;

  const update = (updates: Partial<typeof settings>) => {
    if (nupSettings.value) {
      nupSettings.value = { ...nupSettings.value, ...updates };
    }
  };

  return (
    <div className={styles.panel}>
      <Field label={t('Layout')}>
        {id => (
          <select
            id={id}
            value={settings.layout}
            onChange={e => update({ layout: e.currentTarget.value as NUpLayout })}
            className={styles.select}
          >
            {LAYOUTS.map(l => (
              <option key={l.value} value={l.value}>
                {t(l.label)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={t('Margin ({value}px)', { value: settings.margin })}>
        {id => (
          <input
            id={id}
            type="range"
            min="0"
            max="100"
            step="5"
            value={settings.margin}
            onInput={e => update({ margin: parseInt(e.currentTarget.value, 10) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label={t('Gutter ({value}px)', { value: settings.gutter })}>
        {id => (
          <input
            id={id}
            type="range"
            min="0"
            max="100"
            step="5"
            value={settings.gutter}
            onInput={e => update({ gutter: parseInt(e.currentTarget.value, 10) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label={t('Draw Borders')}>
        {id => (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              cursor: 'pointer',
              font: 'var(--text-small)',
              color: 'var(--ink)'
            }}
          >
            <input
              id={id}
              type="checkbox"
              checked={settings.drawBorders}
              onChange={e => update({ drawBorders: e.currentTarget.checked })}
              style={{ accentColor: 'var(--primary)' }}
            />
            {t('Outline original pages')}
          </label>
        )}
      </Field>
    </div>
  );
}
