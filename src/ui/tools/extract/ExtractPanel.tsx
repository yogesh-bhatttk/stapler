/**
 * Text and Markdown extraction (CNV-04).
 *
 * The previous version called `extractText(doc.id, …)` — the *store* document id —
 * where the render worker expects its own handle, so this feature threw
 * "Document not found" on every use. Handles are resolved in core now.
 */
import { Copy, Download, FileText } from 'lucide-preact';
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { currentDocumentBytes, extractDocumentText } from '../../../core/operations';
import { notify } from '../../../core/notify';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { RadioGroup, TextArea } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { extractSettings, extractedText } from './state';
import { useJob } from '../../useJob';

export function ExtractPanel() {
  const doc = activeDoc.value;
  const settings = extractSettings.value;
  const text = extractedText.value;
  const { run } = useJob();
  if (!doc) return null;

  const selected = selectedPageKeys.value;
  const indices = doc.pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => selected.size === 0 || selected.has(page.key))
    .map(({ index }) => index);

  const extract = () =>
    run({ label: 'Extracting text', scope: 'extract' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const result = await extractDocumentText(bytes, indices, settings.mode, job);
      extractedText.value = result;
      if (!result.trim()) {
        notify('warning', 'No extractable text on these pages.', {
          detail: 'They are probably scanned images. OCR is planned for a later release (OCR-01).'
        });
      }
    });

  const download = async () => {
    const bytes = new TextEncoder().encode(text);
    const extension = settings.mode === 'markdown' ? 'md' : 'txt';
    await platform.saveFileAs(bytes, `${doc.name.replace(/\.[^.]+$/, '')}.${extension}`);
  };

  return (
    <>
      <RadioGroup<'text' | 'markdown'>
        legend="Output"
        name="extractMode"
        value={settings.mode}
        onChange={mode => (extractSettings.value = { mode })}
        options={[
          { value: 'text', label: 'Plain text' },
          { value: 'markdown', label: 'Markdown', hint: 'Promotes larger type to headings' }
        ]}
      />

      <p className={panelStyles.description}>
        {selected.size > 0
          ? `${selected.size} selected page(s).`
          : `All ${doc.pages.length} pages.`}
      </p>

      <Button variant="secondary" icon={FileText} onClick={extract}>
        Extract text
      </Button>

      {text && (
        <div className={panelStyles.section}>
          <div className={panelStyles.section}>
            <Button
              variant="tertiary"
              size="compact"
              icon={Copy}
              onClick={async () => {
                await navigator.clipboard.writeText(text);
                notify('success', 'Copied to the clipboard.');
              }}
            >
              Copy
            </Button>
            <Button variant="tertiary" size="compact" icon={Download} onClick={download}>
              Download
            </Button>
          </div>
          <TextArea readOnly value={text} aria-label="Extracted text" />
        </div>
      )}
    </>
  );
}
