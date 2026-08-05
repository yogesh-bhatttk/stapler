import { formFields, formValues } from './state';
import type { PageRef } from '../../../core/store';
import styles from './AcroFormOverlay.module.css';
import { useTranslation } from '../../../core/i18n';

export interface AcroFormOverlayProps {
  page: PageRef;
  width: number;
  height: number;
}

export function AcroFormOverlay({ page, width, height }: AcroFormOverlayProps) {
  const t = useTranslation();
  const data = formFields.value;
  if (!data || data.isXfa || data.fields.length === 0) return null;

  // Find fields that have a rect on this page
  const visibleFields = data.fields.flatMap(field => {
    return field.rects.filter(r => r.pageIndex === page.sourceIndex).map(rect => ({ field, rect }));
  });

  if (visibleFields.length === 0) return null;

  return (
    <div className={styles.layer} style={{ width: `${width}px`, height: `${height}px` }}>
      {visibleFields.map(({ field, rect }, index) => {
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
          input = (
            <select
              className={styles.select}
              value={value as string}
              disabled={field.isReadOnly}
              onChange={e => onChange((e.target as HTMLSelectElement).value)}
            >
              <option value="" disabled>
                {t('Select an option')}
              </option>
              {field.options?.map(opt => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
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
