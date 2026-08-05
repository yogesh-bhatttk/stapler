/**
 * Redaction options and the verification report (RED-01, RED-03).
 *
 * The copy here is deliberately precise about what the tool does and does not
 * promise (PLAN §5.5): affected pages become images, so their text stops being
 * selectable, and that is stated up front rather than discovered afterwards.
 */
import { useState } from 'preact/hooks';
import { Search, Trash2 } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, searchForRedaction } from '../../../core/operations';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Checkbox, Field, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { VerificationReport } from './VerificationReport';
import { pendingRedactions, redactionReport } from './state';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

export function RedactPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const regions = pendingRedactions.value;
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const { run } = useJob();
  if (!doc) return null;

  const search = () =>
    run({ label: `Searching for "${query}"`, scope: 'redact.search' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const found = await searchForRedaction(bytes, query.trim(), matchCase, job);
      if (found.length === 0) {
        notify('warning', `No matches for "${query.trim()}".`);
        return;
      }
      // Existing marks are kept: searching twice for different terms should add to
      // the list, not replace it.
      pendingRedactions.value = [...regions, ...found];
      notify('info', `Marked ${found.length} occurrence(s).`, {
        detail: 'Review the list, then use Verify & apply.'
      });
    });

  return (
    <>
      <Field label={t('Find and mark text')}>
        {id => (
          <TextInput
            id={id}
            value={query}
            placeholder={t('Account number, name…')}
            onInput={event => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && query.trim()) search();
            }}
          />
        )}
      </Field>
      <Checkbox label={t('Match case')} checked={matchCase} onChange={setMatchCase} />
      <Button variant="secondary" icon={Search} disabled={!query.trim()} onClick={search}>
        {t('Mark every occurrence')}
      </Button>

      <hr className={panelStyles.divider} />

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>
          {t('Marks (')}
          {regions.length})
        </h3>
        {regions.length === 0 ? (
          <p className={panelStyles.description}>
            {t(
              'Draw a rectangle on the page, or search above. Nothing is changed until you apply.'
            )}
          </p>
        ) : (
          <ul className={panelStyles.list}>
            {regions.map((region, index) => (
              <li className={panelStyles.listRow} key={`${region.pageIndex}-${index}`}>
                <span className={panelStyles.listRowText}>
                  {region.text ? `"${region.text}"` : 'Drawn region'} {t('· page')}
                  {region.pageIndex + 1}
                </span>
                <IconButton
                  icon={Trash2}
                  size="compact"
                  aria-label={`Remove mark ${index + 1}`}
                  onClick={() => (pendingRedactions.value = regions.filter((_, i) => i !== index))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className={panelStyles.note}>
        {t(
          'Applying replaces each affected page with an image of itself, so no text, font, or image data survives underneath the marks. Text on those pages stops being selectable. Stapler verifies removal and refuses to save if it cannot.'
        )}
      </p>

      {redactionReport.value && <VerificationReport />}
    </>
  );
}
