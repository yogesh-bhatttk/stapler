/**
 * DOC-10 — lists the session's operation log (`core/history.ts`) and exports it
 * as a text file. Read-only: nothing here writes to the document or the log.
 */
import { Download } from 'lucide-preact';
import { historyVersion, operationLog } from '../../../core/history';
import { platform } from '../../../platform/current';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';

function formatEntry(entry: { label: string; timestamp: number }): string {
  return `${new Date(entry.timestamp).toLocaleString()}  —  ${entry.label}`;
}

export function HistoryPanel() {
  const t = useTranslation();
  // Reading `.value` subscribes this component to every push/undo/redo/reset —
  // `operationLog()` itself is a plain array snapshot, not reactive on its own.
  void historyVersion.value;
  const log = operationLog();

  const handleExport = async () => {
    const lines = log.length > 0 ? log.map(formatEntry) : ['No operations recorded this session.'];
    const bytes = new TextEncoder().encode(lines.join('\n'));
    await platform.saveFileAs(bytes, 'stapler-edit-history.txt');
  };

  return (
    <>
      <div className={panelStyles.section}>
        <p className={panelStyles.description}>
          {t(
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
                <span className={panelStyles.listRowText}>{entry.label}</span>
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
