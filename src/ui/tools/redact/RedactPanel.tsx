import { translate } from '../../../core/i18n';
/**
 * Redaction options and the verification report (RED-01, RED-03).
 *
 * The copy here is deliberately precise about what the tool does and does not
 * promise (PLAN §5.5): affected pages become images, so their text stops being
 * selectable, and that is stated up front rather than discovered afterwards.
 */
import { useState } from 'preact/hooks';
import { Check, ScanSearch, Search, Trash2, X } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, scanForPatterns, findTextRegions } from '../../../core/operations';
import { PATTERN_LABELS, type PatternCategory } from '../../../core/patterns';
import type { PatternSuggestion } from '../../../core/workers/render.worker';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Checkbox, Field, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { VerificationReport } from './VerificationReport';
import { patternScanRan, patternSuggestions, pendingRedactions, redactionReport } from './state';
import { useJob } from '../../useJob';
import { useTranslation } from '../../../core/i18n';

export function RedactPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const regions = pendingRedactions.value;
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const suggestions = patternSuggestions.value;
  const { run } = useJob();
  if (!doc) return null;

  const scan = () =>
    run({ label: 'Scanning for sensitive data', scope: 'redact.scan' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const found = await scanForPatterns(bytes, job);
      patternSuggestions.value = found;
      patternScanRan.value = true;
      if (found.length === 0) {
        notify(
          'info',
          translate('No emails, phone numbers, SSNs, card numbers, or IP addresses found.')
        );
        return;
      }
      notify(
        'info',
        translate('{count} suggestion(s) found — nothing is marked yet.', {
          count: found.length
        }),
        {
          detail: 'Accept the ones you want redacted; the rest are left alone.'
        }
      );
    });

  /** Accepting is the only path from a suggestion to a mark. */
  const accept = (accepted: PatternSuggestion[]) => {
    if (accepted.length === 0) return;
    const ids = new Set(accepted.map(s => s.id));
    pendingRedactions.value = [...pendingRedactions.value, ...accepted.flatMap(s => s.regions)];
    patternSuggestions.value = suggestions.filter(s => !ids.has(s.id));
  };

  const dismiss = (id: string) => {
    patternSuggestions.value = suggestions.filter(s => s.id !== id);
  };

  const byCategory = (Object.keys(PATTERN_LABELS) as PatternCategory[])
    .map(category => ({ category, items: suggestions.filter(s => s.category === category) }))
    .filter(group => group.items.length > 0);

  const search = () =>
    run({ label: `Searching for "${query}"`, scope: 'redact.search' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const found = await findTextRegions(bytes, query.trim(), matchCase, job);
      if (found.length === 0) {
        notify('warning', translate('No matches for "{query}".', { query: query.trim() }));
        return;
      }
      // Existing marks are kept: searching twice for different terms should add to
      // the list, not replace it.
      pendingRedactions.value = [...regions, ...found];
      notify('info', translate('Marked {count} occurrence(s).', { count: found.length }), {
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
        <h2 className={panelStyles.title}>{t('Suggested marks')}</h2>
        <p className={panelStyles.description}>
          {t(
            'Scans the page text for emails, phone numbers, US Social Security numbers, Luhn-valid card numbers, and IP addresses. Suggestions are never redacted until you accept them; an accepted one becomes an ordinary mark you can move, resize, or remove.'
          )}
        </p>
        <Button variant="secondary" icon={ScanSearch} onClick={scan}>
          {t('Scan for sensitive data')}
        </Button>

        {patternScanRan.value && suggestions.length === 0 && (
          <p className={panelStyles.note}>{t('Nothing left to review from the last scan.')}</p>
        )}

        {byCategory.map(({ category, items }) => (
          <div className={panelStyles.section} key={category}>
            <h3 className={panelStyles.title}>
              {t(PATTERN_LABELS[category])} ({items.length})
            </h3>
            <ul className={panelStyles.list} aria-label={`${PATTERN_LABELS[category]} suggestions`}>
              {items.map(item => (
                <li className={panelStyles.listRow} key={item.id}>
                  <span className={panelStyles.listRowText}>
                    {item.text} {t('· page')} {item.pageIndex + 1}
                  </span>
                  <IconButton
                    icon={Check}
                    size="compact"
                    aria-label={`Accept ${PATTERN_LABELS[category]} ${item.text} on page ${item.pageIndex + 1} as a redaction mark`}
                    onClick={() => accept([item])}
                  />
                  <IconButton
                    icon={X}
                    size="compact"
                    aria-label={`Dismiss ${PATTERN_LABELS[category]} ${item.text} on page ${item.pageIndex + 1}`}
                    onClick={() => dismiss(item.id)}
                  />
                </li>
              ))}
            </ul>
            <Button
              variant="tertiary"
              size="compact"
              icon={Check}
              onClick={() => accept(items)}
              aria-label={`Accept all ${items.length} ${PATTERN_LABELS[category]} suggestions`}
            >
              {t('Accept all')}
            </Button>
          </div>
        ))}
      </div>

      <hr className={panelStyles.divider} />

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>
          {t('Marks (')}
          {regions.length})
        </h2>
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
                  {region.text ? `"${region.text}"` : 'Drawn region'} {t('· page')}{' '}
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
          'Applying removes text operators, image references, and annotations inside each marked region at the PDF operator level, then draws an opaque block on top. Stapler verifies removal and refuses to save if any content survives.'
        )}
      </p>

      {redactionReport.value && <VerificationReport />}
    </>
  );
}
