/**
 * Remove-blank-pages options (OPS-05). Detection only ever *selects* candidates;
 * removal is a separate confirmed action, because a false positive here destroys
 * content.
 */
import { Search } from 'lucide-preact';
import { activeDoc, selectedPageKeys, setPageSelection } from '../../../core/store';
import { currentDocumentBytes, detectBlankPages } from '../../../core/operations';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { Field, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { removeBlanksThreshold } from '../state';
import { useJob } from '../../useJob';
import { tPlural, translate, useTranslation } from '../../../core/i18n';

export function BlanksPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const threshold = removeBlanksThreshold.value;
  const { run } = useJob();
  if (!doc) return null;

  const detect = () =>
    run({ label: translate('Looking for blank pages'), scope: 'blanks.detect' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const indices = await detectBlankPages(bytes, threshold, job);
      setPageSelection(indices.map(index => doc.pages[index]?.key).filter(Boolean) as string[]);
      notify(
        indices.length > 0 ? 'info' : 'warning',
        indices.length > 0
          ? tPlural('Marked {count} pages as blank.', indices.length)
          : translate('No blank pages at this sensitivity.'),
        {
          detail:
            indices.length > 0
              ? translate('Review them in the grid before confirming. Nothing has been removed.')
              : translate('Move the slider towards Forgiving to allow more ink.')
        }
      );
    });

  return (
    <>
      <Field label={t('Sensitivity')} value={String(threshold)}>
        {id => (
          <Slider
            id={id}
            min={0}
            max={100}
            value={threshold}
            scale={[t('Strict'), t('Forgiving')]}
            onChange={value => (removeBlanksThreshold.value = value)}
          />
        )}
      </Field>

      <Button variant="secondary" icon={Search} onClick={() => void detect()}>
        {t('Detect blank pages')}
      </Button>

      {selectedPageKeys.value.size > 0 && (
        <p className={panelStyles.note}>
          {tPlural(
            '{count} pages marked. Check them in the grid, then use Delete selected — nothing is removed until you confirm.',
            selectedPageKeys.value.size
          )}
        </p>
      )}
    </>
  );
}
