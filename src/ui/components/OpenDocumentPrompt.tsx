/**
 * UX-01 — the empty state every tool panel falls back to when no document is
 * open. Used to be inert text (`OptionsPanel.tsx`); now it opens a document
 * through the same pipeline as the home route's drop zone
 * (`core/open-document`), so there's no dead end that sends the user back to
 * the home route by hand.
 */
import { useState } from 'preact/hooks';
import { UploadCloud } from 'lucide-preact';
import { pickAndImportFiles } from '../../core/open-document';
import { useImageImportOptions } from '../useImageImportOptions';
import { useTranslation } from '../../core/i18n';
import { Button } from './Button';
import { panelStyles } from '../shell/panelStyles';

export function OpenDocumentPrompt() {
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const { requestOptions, node } = useImageImportOptions();

  const open = async () => {
    setBusy(true);
    try {
      await pickAndImportFiles({ requestImageOptions: requestOptions });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panelStyles.section}>
      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t('Open a document to use this tool.')}
      </p>
      <Button variant="primary" icon={UploadCloud} onClick={open} disabled={busy}>
        {t('Open a document…')}
      </Button>
      {node}
    </div>
  );
}
