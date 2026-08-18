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
import { panelStyles } from '../shell/panelStyles';
import { annotateFlattenOnExport, signFlattenOnExport } from './state';

export interface FlattenOptionProps {
  mode: 'sign' | 'annotate';
}

export function FlattenOption({ mode }: FlattenOptionProps) {
  const t = useTranslation();
  const setting = mode === 'sign' ? signFlattenOnExport : annotateFlattenOnExport;
  const on = setting.value;

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Finalize')}</h2>
      <Checkbox
        label={t('Flatten form fields and annotations on export')}
        checked={on}
        onChange={value => (setting.value = value)}
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
