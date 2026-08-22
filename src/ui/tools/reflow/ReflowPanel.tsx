/**
 * ACC-03 — reflow view options: just the reading font size. The view itself
 * lives in `ReflowView.tsx`, rendered by `Canvas.tsx` in place of the normal
 * page image.
 */
import { activeDoc } from '../../../core/store';
import { Field, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';
import { reflowFontSize } from './state';

export function ReflowPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  if (!doc) return null;

  return (
    <div className={panelStyles.section}>
      <p className={panelStyles.description}>
        {t(
          'Presentational only — this never changes the document. Multi-column pages are read in the same left-to-right order as the Extract Text tool, not column by column.'
        )}
      </p>
      <Field label={t('Text size ({size}px)', { size: reflowFontSize.value })}>
        {id => (
          <Slider
            id={id}
            min={14}
            max={40}
            step={1}
            value={reflowFontSize.value}
            onChange={size => (reflowFontSize.value = size)}
            ariaLabel={t('Reflow text size')}
          />
        )}
      </Field>
    </div>
  );
}
