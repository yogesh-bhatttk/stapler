import { watermarkSettings, type WatermarkPosition } from './state';
import { Field } from '../../components/Field';
import styles from './WatermarkPanel.module.css';

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'top-left', label: 'Top Left' },
  { value: 'top-center', label: 'Top Center' },
  { value: 'top-right', label: 'Top Right' },
  { value: 'center-left', label: 'Center Left' },
  { value: 'center', label: 'Center' },
  { value: 'center-right', label: 'Center Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
  { value: 'bottom-center', label: 'Bottom Center' },
  { value: 'bottom-right', label: 'Bottom Right' }
];

export function WatermarkPanel() {
  const settings = watermarkSettings.value;

  const update = (updates: Partial<typeof settings>) => {
    watermarkSettings.value = { ...settings, ...updates };
  };

  return (
    <div className={styles.panel}>
      <Field label="Text">
        {id => (
          <>
            <input
              id={id}
              type="text"
              value={settings.text}
              onInput={e => update({ text: e.currentTarget.value })}
              placeholder="CONFIDENTIAL or Page {n}"
              className={styles.input}
            />
            <div className={styles.hint}>
              Use {'{n}'} for page number, {'{total}'} for total pages.
            </div>
          </>
        )}
      </Field>

      <Field label="Position">
        {id => (
          <select
            id={id}
            value={settings.position}
            onChange={e => update({ position: e.currentTarget.value as WatermarkPosition })}
            className={styles.select}
          >
            {POSITIONS.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={`Opacity (${Math.round(settings.opacity * 100)}%)`}>
        {id => (
          <input
            id={id}
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={settings.opacity}
            onInput={e => update({ opacity: parseFloat(e.currentTarget.value) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label={`Rotation (${settings.rotation}°)`}>
        {id => (
          <input
            id={id}
            type="range"
            min="-90"
            max="90"
            step="15"
            value={settings.rotation}
            onInput={e => update({ rotation: parseFloat(e.currentTarget.value) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label={`Font Size (${settings.fontSize}px)`}>
        {id => (
          <input
            id={id}
            type="range"
            min="12"
            max="144"
            step="2"
            value={settings.fontSize}
            onInput={e => update({ fontSize: parseFloat(e.currentTarget.value) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label="Color">
        {id => (
          <input
            id={id}
            type="color"
            value={settings.color}
            onInput={e => update({ color: e.currentTarget.value })}
            className={styles.colorPicker}
          />
        )}
      </Field>
    </div>
  );
}
