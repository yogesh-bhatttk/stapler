/**
 * Organize options (OPS-02). Bulk actions over the current selection, each with a
 * keyboard equivalent documented in the shortcut sheet.
 */
import { useLocation } from 'wouter-preact';
import { Copy, Crop as CropIcon, RotateCcw, RotateCw, Trash2 } from 'lucide-preact';
import {
  activeDoc,
  activePageIndex,
  deletePages,
  duplicatePages,
  rotatePages,
  selectAllPages,
  clearPageSelection,
  selectedPageKeys
} from '../../../core/store';
import { toolRoute } from '../../../core/tools';
import { cropSettings } from '../crop/state';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';

export function OrganizePanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const selection = selectedPageKeys.value;
  const [, setLocation] = useLocation();
  if (!doc) return null;

  // With nothing ticked, a bulk action applies to the whole document — which is what
  // "rotate all" means, and it saves selecting 300 pages first.
  const targets = selection.size > 0 ? [...selection] : doc.pages.map(p => p.key);
  const scope = selection.size > 0 ? `${selection.size} selected` : `all ${doc.pages.length}`;

  // UX-06: a shortcut into the Crop tool, honestly scoped — Crop's scope model
  // (current/all/odd/even) has no notion of an arbitrary multi-page selection, so
  // rather than inventing one, an in-between selection just disables the button.
  const openCrop = () => {
    if (selection.size === 0) {
      cropSettings.value = { ...cropSettings.value, scope: 'all' };
    } else {
      const [key] = selection;
      const index = doc.pages.findIndex(p => p.key === key);
      if (index !== -1) activePageIndex.value = index;
      cropSettings.value = { ...cropSettings.value, scope: 'current' };
    }
    setLocation(toolRoute('crop'));
  };

  return (
    <>
      <p className={panelStyles.description}>
        {t('Acting on')} {scope} {t('page(s).')}
      </p>

      <div className={panelStyles.section}>
        <Button
          variant="secondary"
          icon={RotateCw}
          onClick={() => rotatePages(doc.id, targets, 90)}
        >
          {t('Rotate right')}
        </Button>
        <Button
          variant="secondary"
          icon={RotateCcw}
          onClick={() => rotatePages(doc.id, targets, -90)}
        >
          {t('Rotate left')}
        </Button>
        <Button variant="secondary" icon={Copy} onClick={() => duplicatePages(doc.id, targets)}>
          {t('Duplicate')}
        </Button>
        <Button
          variant="secondary"
          icon={CropIcon}
          disabled={selection.size > 1}
          onClick={openCrop}
        >
          {t('Crop…')}
        </Button>
        <Button
          variant="danger"
          icon={Trash2}
          disabled={targets.length >= doc.pages.length && selection.size === 0}
          onClick={() => deletePages(doc.id, targets)}
        >
          {t('Delete')}
        </Button>
      </div>

      <hr className={panelStyles.divider} />

      <div className={panelStyles.section}>
        <Button variant="tertiary" size="compact" onClick={() => selectAllPages(doc.id)}>
          {t('Select all')}
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          disabled={selection.size === 0}
          onClick={clearPageSelection}
        >
          {t('Clear selection')}
        </Button>
      </div>
    </>
  );
}
