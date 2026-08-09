import { formFields, formValues } from './state';

import styles from './AcroFormOverlay.module.css';
import { useTranslation } from '../../../core/i18n';

export interface AcroFormOverlayProps {
  pageIndex: number;
  width: number;
  height: number;
}

export function AcroFormOverlay({ pageIndex, width, height }: AcroFormOverlayProps) {
  const t = useTranslation();
  const data = formFields.value;
  if (!data || data.isXfa || data.fields.length === 0) return null;

  // Find fields that have a rect on this page. `widgetIndex` is the widget's
  // position within the *unfiltered* `field.rects` — the same order pdf-lib
  // reports `field.getOptions()` in for a RadioGroup, so it is what pairs a
  // given radio widget on the page with the export value it represents.
  const visibleFields = data.fields.flatMap(field =>
    field.rects
      .map((rect, widgetIndex) => ({ field, rect, widgetIndex }))
      .filter(({ rect: r }) => r.pageIndex === pageIndex)
  );

  if (visibleFields.length === 0) return null;

  return (
    <div className={styles.layer} style={{ width: `${width}px`, height: `${height}px` }}>
      {visibleFields.map(({ field, rect, widgetIndex }, index) => {
        const value = formValues.value[field.name] ?? field.value;
        const style = {
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`
        };

        const onChange = (newValue: string | string[] | boolean) => {
          formValues.value = { ...formValues.value, [field.name]: newValue };
        };

        let input;
        if (field.type === 'TextField') {
          input = (
            <textarea
              className={styles.input}
              value={value as string}
              readOnly={field.isReadOnly}
              onInput={e => onChange((e.target as HTMLTextAreaElement).value)}
            />
          );
        } else if (field.type === 'CheckBox') {
          input = (
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={value as boolean}
              disabled={field.isReadOnly}
              onChange={e => onChange((e.target as HTMLInputElement).checked)}
            />
          );
        } else if (field.type === 'RadioGroup') {
          // One widget rect = one physical radio button on the page. A `<select>`
          // repeated at every widget's position offered the whole option list at
          // each bullet — visually mismatched with the page artwork and unusable
          // with more than one option. A native radio per widget, sharing the
          // field's name, is both correct and free keyboard/arrow-key navigation.
          const optionValue = field.options?.[widgetIndex] ?? '';
          input = (
            <input
              type="radio"
              className={styles.checkbox}
              name={field.name}
              value={optionValue}
              checked={value === optionValue}
              disabled={field.isReadOnly}
              onChange={() => onChange(optionValue)}
              aria-label={optionValue || field.name}
            />
          );
        } else if (field.type === 'Dropdown' || field.type === 'OptionList') {
          input = (
            <select
              className={styles.select}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              value={value as any}
              disabled={field.isReadOnly}
              multiple={field.type === 'OptionList'}
              onChange={e => {
                const target = e.target as HTMLSelectElement;
                const selected = Array.from(target.selectedOptions).map(o => o.value);
                onChange(selected);
              }}
            >
              {field.options?.map(opt => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          );
        } else {
          input = <div className={styles.unknown}>{t('Unsupported')}</div>;
        }

        return (
          <div
            key={`${field.name}-${index}`}
            className={styles.field}
            style={style}
            title={field.name}
          >
            {input}
          </div>
        );
      })}
    </div>
  );
}
