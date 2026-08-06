import { useState } from 'preact/hooks';
import { useTranslation } from '../../../core/i18n';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { notify, notifyError } from '../../../core/notify';
import { processWorker } from '../../../core/workers/index';
import { platform } from '../../../platform/current';
import { panelStyles } from '../../shell/OptionsPanel';

export function MarkdownToPdfPanel() {
  const t = useTranslation();
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);

  const exportPdf = async () => {
    if (!markdown.trim()) return;
    setBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bytes = (await processWorker.lease((api: any) =>
        api.markdownToPdf(markdown)
      )) as Uint8Array;
      await platform.saveFileAs(bytes, 'document.pdf');
      notify('success', t('PDF saved successfully.'));
    } catch (err) {
      notifyError('md-to-pdf.export', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={panelStyles.section}>
        <Field label={t('Markdown Content')}>
          {id => (
            <textarea
              id={id}
              value={markdown}
              onInput={e => setMarkdown(e.currentTarget.value)}
              placeholder={t('# Hello\n\nWrite some markdown here...')}
              rows={15}
              style={{ width: '100%', resize: 'vertical' }}
            />
          )}
        </Field>
      </div>

      <div className={panelStyles.section}>
        <Button variant="primary" onClick={exportPdf} disabled={busy || !markdown.trim()}>
          {t('Export to PDF')}
        </Button>
      </div>
    </>
  );
}
