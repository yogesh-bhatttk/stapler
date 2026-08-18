import { useTranslation } from '../../../core/i18n';
import { Field } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { markdownToPdfSource } from '../state';

export function MarkdownToPdfPanel() {
  const t = useTranslation();

  return (
    <div className={panelStyles.section}>
      <Field label={t('Markdown Content')}>
        {id => (
          <textarea
            id={id}
            value={markdownToPdfSource.value}
            onInput={e => (markdownToPdfSource.value = e.currentTarget.value)}
            placeholder={t('# Hello\n\nWrite some markdown here...')}
            rows={15}
            style={{ width: '100%', resize: 'vertical' }}
          />
        )}
      </Field>
    </div>
  );
}
