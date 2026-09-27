/**
 * DOC-10 — lists the active document's operation log (`core/history.ts`) and
 * exports it as a text file. Read-only: nothing here writes to the document
 * or the log.
 *
 * GAP-11a — each open document has its own undo history, so this shows the
 * active document's and follows the tab bar: switching tabs switches the log.
 */
import { Download } from 'lucide-preact';
import { historyVersion, operationLog } from '../../../core/history';
import { activeDoc } from '../../../core/store';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { translate, useTranslation } from '../../../core/i18n';

function formatEntry(entry: { label: string; timestamp: number }): string {
  // `label` is a tool title stored as its English key (`tKey`), translated here.
  return `${new Date(entry.timestamp).toLocaleString()}  —  ${translate(entry.label)}`;
}

export function HistoryPanel() {
  const t = useTranslation();
  // Reading `.value` subscribes this component to every push/undo/redo/reset —
  // `operationLog()` itself is a plain array snapshot, not reactive on its own.
  void historyVersion.value;
  const doc = activeDoc.value;
  const log = doc ? operationLog(doc.id) : [];

  const handleExport = async () => {
    const lines = [
      ...(doc ? [doc.name, ''] : []),
      ...(log.length > 0 ? log.map(formatEntry) : [t('No operations recorded this session.')])
    ];
    const bytes = new TextEncoder().encode(lines.join('\n'));
    await platform.saveFileAs(bytes, 'stapler-edit-history.txt');
  };

  return (
    <>
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {doc
            ? t(
                'Every edit made to {name} this session, in order. Each open document keeps its own history; an edit you undo is left out.',
                { name: doc.name }
              )
            : t(
                'Every operation applied this session, in order. An operation you undo before exporting this log is left out.'
              )}
        </p>
      </div>

      <div className={panelStyles.section}>
        {log.length === 0 ? (
          <p className={panelStyles.description}>{t('No operations recorded yet.')}</p>
        ) : (
          <ol className={panelStyles.list} aria-label={t('Operation log')}>
            {log.map((entry, i) => (
              <li key={i} className={panelStyles.listRow}>
                <span className={panelStyles.listRowText}>{t(entry.label)}</span>
                <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={panelStyles.section}>
        <Button icon={Download} onClick={handleExport}>
          {t('Export log as text')}
        </Button>
      </div>
    </>
  );
}
