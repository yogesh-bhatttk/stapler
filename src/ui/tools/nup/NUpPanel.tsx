import { useEffect } from 'preact/hooks';
import { Field } from '../../components/Field';
import { nupSettings, type NUpLayout } from './state';
import styles from './NUpPanel.module.css';

const LAYOUTS: { value: NUpLayout; label: string }[] = [
  { value: '2-up', label: '2-up' },
  { value: '4-up', label: '4-up' },
  { value: 'booklet', label: 'Booklet' }
];

export function NUpPanel() {
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
      <Field label="Layout">
        {id => (
          <select
            id={id}
            value={settings.layout}
            onChange={e => update({ layout: e.currentTarget.value as NUpLayout })}
            className={styles.select}
          >
            {LAYOUTS.map(l => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={`Margin (${settings.margin}px)`}>
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

      <Field label={`Gutter (${settings.gutter}px)`}>
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

      <Field label="Draw Borders">
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
            Outline original pages
          </label>
        )}
      </Field>
    </div>
  );
}
