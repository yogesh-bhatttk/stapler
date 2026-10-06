/**
 * GAP-6 — duplex interleave, shown in Merge and Organize.
 *
 * Two single-sided scans of a double-sided stack (all fronts, then all backs —
 * two merged files, or one file) become one document in reading order. Pure
 * page-order work on the page list: one undo step, nothing re-encoded.
 */
import { useEffect, useId, useState } from 'preact/hooks';
import { ArrowLeftRight } from 'lucide-preact';
import { activeDoc, reorderPages } from '../../../core/store';
import { defaultFrontCount, interleaveDuplex } from '../../../core/duplex';
import { notify } from '../../../core/notify';
import { tPlural, translate, useTranslation } from '../../../core/i18n';
import { refuseEditWhileBusy } from '../../busy';
import { Button } from '../../components/Button';
import { Checkbox, Field, NumberStepper } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';

export function DuplexSection() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const pageCount = doc?.pages.length ?? 0;
  const suggested = doc ? defaultFrontCount(doc.pages.map(p => p.sourceDocId)) : 0;
  const [fronts, setFronts] = useState(suggested);
  const [reversed, setReversed] = useState(true);
  // UI-8 — the page order the last interleave produced, per document. While
  // the document still has exactly that order, a second press would
  // interleave the already-interleaved pages and scramble them, so the
  // button stays disabled until the order changes (a move, an undo, …).
  const doneNoteId = useId();
  const [produced, setProduced] = useState<{ docId: string; order: string } | null>(null);

  // A different document, or pages added/removed: start again from the
  // suggestion rather than keep a split point that meant another page list.
  useEffect(() => setFronts(suggested), [doc?.id, pageCount, suggested]);

  if (!doc || pageCount < 2) return null;
  const frontCount = Math.max(1, Math.min(pageCount - 1, fronts));
  const plan = interleaveDuplex(doc.pages, frontCount, reversed);
  const alreadyInterleaved = isProducedOrder(produced, doc.id, doc.pages);

  const apply = () => {
    if (refuseEditWhileBusy() || alreadyInterleaved) return;
    const order = plan.pages.map(p => p.key);
    if (reorderPages(doc.id, order)) {
      setProduced({ docId: doc.id, order: order.join('\n') });
      notify('success', translate('Pages interleaved.'), {
        detail: translate('Front 1, back 1, front 2, back 2… Undo with Ctrl+Z.')
      });
    }
  };

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Duplex scan')}</h2>
      <p className={panelStyles.description}>
        {t(
          'Scanned all the fronts, then all the backs? Interleave them into reading order. The fronts must come first in this document.'
        )}
      </p>
      <Field label={t('Number of front pages')} hint={t('The pages after these are the backs.')}>
        {id => (
          <NumberStepper
            id={id}
            value={frontCount}
            min={1}
            max={pageCount - 1}
            onChange={setFronts}
          />
        )}
      </Field>
      <Checkbox
        label={t('Backs are in reverse order (as a sheet feeder produces them)')}
        checked={reversed}
        onChange={setReversed}
      />
      {plan.fit === 'last-front-alone' && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('One more front than backs: the last sheet has no back, so it goes at the end.')}
        </p>
      )}
      {plan.fit === 'mismatch' && (
        <p className={panelStyles.note} role="note">
          {translate('{fronts} and {backs} do not pair up.', {
            fronts: tPlural('{count} fronts', plan.fronts),
            backs: tPlural('{count} backs', plan.backs)
          })}{' '}
          {tPlural(
            'The pairs that exist are interleaved and the {count} extra pages are kept at the end, in scan order. Check the number of front pages first.',
            plan.unpaired
          )}
        </p>
      )}
      {alreadyInterleaved && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`} id={doneNoteId}>
          {t(
            'These pages are already interleaved. Change the page order, or undo, to interleave again.'
          )}
        </p>
      )}
      <Button
        variant="secondary"
        icon={ArrowLeftRight}
        onClick={apply}
        disabled={alreadyInterleaved}
        aria-describedby={alreadyInterleaved ? doneNoteId : undefined}
      >
        {plan.fit === 'mismatch' ? t('Interleave anyway') : t('Interleave pages')}
      </Button>
    </div>
  );
}

/** UI-8 — whether `pages` is still exactly the order the last interleave of `docId` produced. */
export function isProducedOrder(
  produced: { docId: string; order: string } | null,
  docId: string,
  pages: readonly { key: string }[]
): boolean {
  return (
    produced !== null &&
    produced.docId === docId &&
    produced.order === pages.map(p => p.key).join('\n')
  );
}
