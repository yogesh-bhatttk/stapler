/**
 * SGN-05 — the finalize toggle, shared by the Sign and Annotate panels.
 *
 * One component in two panels rather than two copies: the requirement calls
 * flattening "a natural finalize step after SGN-03 fill or ANN-01 annotation",
 * and those are the only two tools that offer it. It is a plain `Checkbox`, so
 * it is reachable by Tab, toggles on Space, and carries its own label.
 */
import { useTranslation } from '../../core/i18n';
import { Checkbox } from '../components/Field';
import { panelStyles } from '../shell/OptionsPanel';
import { flattenOnExport } from './state';

export function FlattenOption() {
  const t = useTranslation();
  const on = flattenOnExport.value;

  return (
    <div className={panelStyles.section}>
      <h3 className={panelStyles.title}>{t('Finalize')}</h3>
      <Checkbox
        label={t('Flatten form fields and annotations on export')}
        checked={on}
        onChange={value => (flattenOnExport.value = value)}
      />
      <p className={panelStyles.description}>
        {on
          ? t(
              'Filled values, stamps, and annotations are drawn into the page, and the interactive fields and annotation dictionaries are removed. The export cannot be re-edited. Links stop being clickable.'
            )
          : t(
              'Form fields and annotations stay interactive in the export, so the values can still be changed.'
            )}
      </p>
    </div>
  );
}
