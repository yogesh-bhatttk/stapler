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

/** The active document's pages now, or null once another document is active. */
function livePages(docId: string) {
  const doc = activeDoc.value;
  return doc?.id === docId ? doc.pages : null;
}
import { scanForPatterns, findTextRegions } from '../../../core/operations';
import { documentContentBytes } from '../export-compose';
import { PATTERN_LABELS, type PatternCategory } from '../../../core/patterns';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Checkbox, Field, RadioGroup, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { VerificationReport } from './VerificationReport';
import { FaceBlurSection } from './FaceBlurSection';
import {
  marksForPages,
  mergeMarks,
  resolveRedactionMarks,
  patternScanRan,
  patternSuggestions,
  pendingRedactions,
  redactShapeMode,
  redactionReport,
  type PendingSuggestion
} from './state';
import { useJob } from '../../useJob';
import { tPlural, translate, useTranslation } from '../../../core/i18n';

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
    run({ label: translate('Scanning for sensitive data'), scope: 'redact.scan' }, async job => {
      // H1/M2 — the page content the marks will be applied to (the same
      // bytes `Verify & apply` redacts), and the page list it was built from,
      // read in the same tick, so each suggestion is tied to its page.
      const pages = doc.pages;
      const bytes = await documentContentBytes(job, { stamps: true, pages });
      const scanned = await scanForPatterns(bytes, job);
      const tied: PendingSuggestion[] = scanned.flatMap(suggestion => {
        const page = pages[suggestion.pageIndex];
        return page ? [{ ...suggestion, pageKey: page.key, pageRotation: page.rotation }] : [];
      });
      // M1 — a scan cancelled by leaving the panel publishes nothing.
      if (job.signal?.aborted) return;
      // Pages edited while it ran: re-indexed (or dropped) against them now.
      const live = livePages(doc.id);
      if (!live) return;
      const found = resolveRedactionMarks(tied, live).kept.map(suggestion => ({
        ...suggestion,
        regions: suggestion.regions.map(region => ({ ...region, pageIndex: suggestion.pageIndex }))
      }));
      patternSuggestions.value = found;
      patternScanRan.value = true;
      if (found.length === 0) {
        notify(
          'info',
          translate('No emails, phone numbers, SSNs, card numbers, or IP addresses found.')
        );
        return;
      }
      notify('info', tPlural('{count} suggestions found — nothing is marked yet.', found.length), {
        detail: translate('Accept the ones you want redacted; the rest are left alone.')
      });
    });

  /** Accepting is the only path from a suggestion to a mark. */
  const accept = (accepted: PendingSuggestion[]) => {
    if (accepted.length === 0) return;
    const ids = new Set(accepted.map(s => s.id));
    const marks = accepted.flatMap(s =>
      s.regions.map(region => ({
        ...region,
        pageIndex: s.pageIndex,
        pageKey: s.pageKey,
        pageRotation: s.pageRotation
      }))
    );
    pendingRedactions.value = mergeMarks(pendingRedactions.value, marks).marks;
    patternSuggestions.value = patternSuggestions.value.filter(s => !ids.has(s.id));
  };

  const dismiss = (id: string) => {
    patternSuggestions.value = patternSuggestions.value.filter(s => s.id !== id);
  };

  const byCategory = (Object.keys(PATTERN_LABELS) as PatternCategory[])
    .map(category => ({ category, items: suggestions.filter(s => s.category === category) }))
    .filter(group => group.items.length > 0);

  const search = () =>
    run(
      { label: translate('Searching for "{query}"', { query }), scope: 'redact.search' },
      async job => {
        // H1/M2 — the bytes `Verify & apply` will redact, and the page list
        // they were built from, so each match is tied to its page.
        const pages = doc.pages;
        const bytes = await documentContentBytes(job, { stamps: true, pages });
        const tied = marksForPages(
          await findTextRegions(bytes, query.trim(), matchCase, job),
          pages
        );
        if (job.signal?.aborted) return;
        // Pages edited while it ran: re-indexed (or dropped) against them now.
        const live = livePages(doc.id);
        if (!live) return;
        const found = resolveRedactionMarks(tied, live).kept;
        if (found.length === 0) {
          notify('warning', translate('No matches for "{query}".', { query: query.trim() }));
          return;
        }
        // UI#29 — merged into the marks as they are *now* (not as they were
        // when the search started, which dropped every mark drawn meanwhile),
        // and without repeating a mark already there: searching twice for the
        // same term used to list every occurrence twice.
        const { marks, added } = mergeMarks(pendingRedactions.value, found);
        pendingRedactions.value = marks;
        if (added === 0) {
          notify('info', translate('Every occurrence is already marked.'));
          return;
        }
        notify('info', tPlural('Marked {count} occurrences.', added), {
          detail: translate('Review the list, then use Verify & apply.')
        });
      }
    );

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
              if (event.key === 'Enter' && query.trim()) void search();
            }}
          />
        )}
      </Field>
      <Checkbox label={t('Match case')} checked={matchCase} onChange={setMatchCase} />
      <Button
        variant="secondary"
        icon={Search}
        disabled={!query.trim()}
        onClick={() => void search()}
      >
        {t('Mark every occurrence')}
      </Button>

      <hr className={panelStyles.divider} />

      <RadioGroup<'rect' | 'polygon'>
        legend={t('Draw shape')}
        name="redactShape"
        value={redactShapeMode.value}
        onChange={value => (redactShapeMode.value = value)}
        options={[
          { value: 'rect', label: t('Rectangle'), hint: t('Drag a box over the content.') },
          {
            value: 'polygon',
            label: t('Freehand'),
            hint: t(
              'Trace an outline; it closes when you let go. Only what it encloses is removed.'
            )
          }
        ]}
      />

      <hr className={panelStyles.divider} />

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Suggested marks')}</h2>
        <p className={panelStyles.description}>
          {t(
            'Scans the page text for emails, phone numbers, US Social Security numbers, Luhn-valid card numbers, and IP addresses. Suggestions are never redacted until you accept them; an accepted one becomes an ordinary mark you can move, resize, or remove.'
          )}
        </p>
        <Button variant="secondary" icon={ScanSearch} onClick={() => void scan()}>
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
            <ul
              className={panelStyles.list}
              aria-label={t('{category} suggestions', { category: t(PATTERN_LABELS[category]) })}
            >
              {items.map(item => (
                <li className={panelStyles.listRow} key={item.id}>
                  <span className={panelStyles.listRowText}>
                    {item.text} {t('· page {page}', { page: item.pageIndex + 1 })}
                  </span>
                  <IconButton
                    icon={Check}
                    size="compact"
                    aria-label={t('Accept {category} {text} on page {page} as a redaction mark', {
                      category: t(PATTERN_LABELS[category]),
                      text: item.text,
                      page: item.pageIndex + 1
                    })}
                    onClick={() => accept([item])}
                  />
                  <IconButton
                    icon={X}
                    size="compact"
                    aria-label={t('Dismiss {category} {text} on page {page}', {
                      category: t(PATTERN_LABELS[category]),
                      text: item.text,
                      page: item.pageIndex + 1
                    })}
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
              aria-label={tPlural('Accept all {count} {category} suggestions', items.length, {
                category: t(PATTERN_LABELS[category])
              })}
            >
              {t('Accept all')}
            </Button>
          </div>
        ))}
      </div>

      <hr className={panelStyles.divider} />

      <FaceBlurSection />

      <hr className={panelStyles.divider} />

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Marks ({count})', { count: regions.length })}</h2>
        {regions.length === 0 ? (
          <p className={panelStyles.description}>
            {t(
              'Draw a rectangle or a freehand shape on the page, or search above. Nothing is changed until you apply.'
            )}
          </p>
        ) : (
          <ul className={panelStyles.list}>
            {regions.map((region, index) => (
              <li className={panelStyles.listRow} key={`${region.pageIndex}-${index}`}>
                <span className={panelStyles.listRowText}>
                  {region.text
                    ? `"${region.text}"`
                    : region.points
                      ? t('Drawn shape')
                      : t('Drawn region')}{' '}
                  {t('· page {page}', { page: region.pageIndex + 1 })}
                </span>
                <IconButton
                  icon={Trash2}
                  size="compact"
                  aria-label={t('Remove mark {n}', { n: index + 1 })}
                  onClick={() => (pendingRedactions.value = regions.filter((_, i) => i !== index))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className={panelStyles.note}>
        {t(
          'Applying removes text operators, image references, and annotations inside each mark at the PDF operator level, then draws an opaque block — or, for a freehand mark, the shape you traced — on top. A freehand mark only removes what its outline encloses, not the box around it. Stapler verifies removal and refuses to save if any content survives.'
        )}
      </p>

      <p className={panelStyles.note}>
        {t(
          'The redacted copy also loses its bookmarks, attached files, named destinations, and tagged-structure (accessibility) tree: each one can quote or point straight back at what you removed, and none of them can be checked the way page content can. Document metadata and XMP go too. Page labels and layer visibility are kept.'
        )}
      </p>

      {redactionReport.value && <VerificationReport />}
    </>
  );
}
