import { translate } from '../../../core/i18n';
/**
 * Text and Markdown extraction (CNV-04), with an automatic OCR fallback.
 *
 * The previous version called `extractText(doc.id, …)` — the *store* document id —
 * where the render worker expects its own handle, so this feature threw
 * "Document not found" on every use. Handles are resolved in core now.
 *
 * A scanned page has no text layer to read, so a plain extraction on one
 * always came back empty — previously reported as "OCR is planned for a
 * later release," which stopped being true the moment OCR-01 shipped. Making
 * the user notice that, switch to the separate OCR tool, run it, download a
 * new file, and re-import it just to see the words on the page they already
 * had open was the exact friction this fixes: a page with nothing to extract
 * now falls back to running OCR on it automatically (still gated by the
 * model-download consent dialog OCR already requires) and re-extracts from
 * the OCR'd result, in this same panel.
 *
 * That auto-fallback only catches a page with *no* text layer at all — it
 * cannot catch one whose embedded text layer is present but wrong (a broken
 * glyph→Unicode mapping some scanning apps produce; see OCR-04's
 * `stripTextObjects`), because "this string looks like mojibake" has no
 * general, reliable test: a truly broken string and a legitimately odd one
 * are not reliably distinguishable from the bytes alone. So that case gets an
 * explicit, one-click override instead of a guess — "Doesn't look right? Try
 * OCR instead," next to the result — rather than silently trusting whatever
 * the plain extraction returned.
 */
import { Copy, Download, FileScan, FileText } from 'lucide-preact';
import { activeDoc, selectedPageKeys } from '../../../core/store';
import { currentDocumentBytes, extractDocumentText } from '../../../core/operations';
import { runOcr } from '../../../core/ocr/runOcr';
import { OCR_LANGUAGES } from '../../../core/ocr/model';
import { notify } from '../../../core/notify';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { Field, RadioGroup, Select, TextArea } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { extractSettings, extractedText } from './state';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';
import type { JobOptions } from '../../../core/workers/protocol';

export function ExtractPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const settings = extractSettings.value;
  const text = extractedText.value;
  const { run } = useJob();
  if (!doc) return null;

  const update = (patch: Partial<typeof settings>) => {
    extractSettings.value = { ...settings, ...patch };
  };

  const selected = selectedPageKeys.value;
  const indices = doc.pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => selected.size === 0 || selected.has(page.key))
    .map(({ index }) => index);

  /** Runs OCR and re-extracts from its result. `job` already owns the slot. */
  const extractViaOcr = async (job: JobOptions) => {
    const bytes = await currentDocumentBytes(job);
    job.onProgress?.(0, 'Running OCR');
    const ocrResult = await runOcr(bytes, doc.pages.length, {
      ...job,
      lang: settings.lang,
      pageIndices: indices
    });

    // `null` is the user declining the language-model download — a real
    // answer, not a failure.
    if (ocrResult && ocrResult.wordsAdded > 0) {
      extractedText.value = await extractDocumentText(ocrResult.bytes, indices, settings.mode, job);
      notify('success', translate('Read this page with OCR.'), {
        detail:
          `${ocrResult.wordsAdded} word${ocrResult.wordsAdded === 1 ? '' : 's'} recognised. ` +
          'OCR output can contain mistakes a real text layer would not — check anything important.'
      });
      return;
    }

    if (ocrResult) {
      extractedText.value = '';
      notify('warning', translate('No extractable text on these pages.'), {
        detail:
          'OCR found nothing either. A blank, very low-resolution, or heavily skewed scan is ' +
          'the usual cause — try Scan cleanup first.'
      });
    }
  };

  const extract = () =>
    run({ label: 'Extracting text', scope: 'extract' }, async (job: JobOptions) => {
      const bytes = await currentDocumentBytes(job);
      const direct = await extractDocumentText(bytes, indices, settings.mode, job);
      if (direct.trim()) {
        extractedText.value = direct;
        return;
      }

      // Nothing came back at all — almost always a scanned page with no text
      // layer to read in the first place. OCR is the only way to get real
      // text out of it, so it runs automatically rather than making the user
      // notice the empty result, find the separate OCR tool, and come back.
      // A text layer that came back non-empty but *wrong* is a different,
      // harder case — see the module comment — and gets the explicit
      // "Doesn't look right?" button below instead of a guess here.
      await extractViaOcr(job);
    });

  const retryWithOcr = () => run({ label: 'Running OCR', scope: 'extract' }, extractViaOcr);

  const download = async () => {
    const bytes = new TextEncoder().encode(text);
    const extension = settings.mode === 'markdown' ? 'md' : 'txt';
    await platform.saveFileAs(bytes, `${doc.name.replace(/\.[^.]+$/, '')}.${extension}`);
  };

  return (
    <>
      <RadioGroup<'text' | 'markdown'>
        legend={t('Output')}
        name="extractMode"
        value={settings.mode}
        onChange={mode => update({ mode })}
        options={[
          { value: 'text', label: 'Plain text' },
          { value: 'markdown', label: 'Markdown', hint: 'Promotes larger type to headings' }
        ]}
      />

      <Field label={t('If a page turns out to be a scan')}>
        {id => (
          <Select
            id={id}
            value={settings.lang}
            options={OCR_LANGUAGES.map(language => ({
              value: language.code,
              label: language.label
            }))}
            onChange={lang => update({ lang })}
          />
        )}
      </Field>

      <p className={panelStyles.description}>
        {selected.size > 0
          ? `${selected.size} selected page(s).`
          : `All ${doc.pages.length} pages.`}
      </p>

      <p className={panelStyles.description}>
        {t(
          'A page with no text layer is OCR’d automatically — Stapler asks before the ' +
            'one-time language model download it needs, and says what and from where.'
        )}
      </p>

      <Button variant="secondary" icon={FileText} onClick={extract}>
        {t('Extract text')}
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
                notify('success', translate('Copied to the clipboard.'));
              }}
            >
              {t('Copy')}
            </Button>
            <Button variant="tertiary" size="compact" icon={Download} onClick={download}>
              {t('Download')}
            </Button>
            <Button variant="tertiary" size="compact" icon={FileScan} onClick={retryWithOcr}>
              {t("Doesn't look right? Try OCR instead")}
            </Button>
          </div>
          <TextArea readOnly value={text} aria-label={translate('Extracted text')} />
        </div>
      )}
    </>
  );
}
