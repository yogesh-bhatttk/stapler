import { panelStyles } from '../../shell/OptionsPanel';
import { inputDirHandle, outputDirHandle, batchProgress } from './state';
import { EmptyState } from '../../components/Feedback';
import { useTranslation } from '../../../core/i18n';

export function BatchView() {
  const t = useTranslation();

  if (!inputDirHandle.value) {
    return (
      <EmptyState
        title={t('Batch Processing')}
        body="Select an input folder from the Batch panel on the right to start."
      />
    );
  }

  return (
    <div
      style={{
        padding: '2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        width: '100%',
        maxWidth: '600px',
        margin: '0 auto'
      }}
    >
      <h1>{t('Batch Processing')}</h1>

      <div className={panelStyles.section}>
        <p>
          <strong>{t('Input Directory:')}</strong> {inputDirHandle.value.name}
        </p>
        <p>
          <strong>{t('Output Directory:')}</strong>{' '}
          {outputDirHandle.value ? outputDirHandle.value.name : 'Not selected'}
        </p>
      </div>

      {batchProgress.value.isProcessing && (
        <div className={panelStyles.section}>
          <h2>{t('Processing')}</h2>
          <p>
            {t('File:')} {batchProgress.value.currentFile}
          </p>
          <div
            style={{
              width: '100%',
              height: '8px',
              backgroundColor: 'var(--border-control)',
              borderRadius: '4px',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: `${batchProgress.value.total > 0 ? Math.round((batchProgress.value.completed / batchProgress.value.total) * 100) : 0}%`,
                height: '100%',
                backgroundColor: 'var(--primary)',
                transition: 'width 0.2s ease-out'
              }}
            />
          </div>
          <p>
            {batchProgress.value.completed} / {batchProgress.value.total} {t('completed')}
          </p>
          {batchProgress.value.failed > 0 && (
            <p style={{ color: 'var(--danger)' }}>
              {batchProgress.value.failed} {t('failed')}
            </p>
          )}
        </div>
      )}

      {batchProgress.value.notes.length > 0 && (
        <div className={panelStyles.section}>
          <h2>{t('Files written unchanged')}</h2>
          <ul style={{ margin: 0, paddingInlineStart: '20px' }}>
            {batchProgress.value.notes.map(note => (
              <li key={`${note.file}-${note.detail}`}>
                <strong>{note.file}</strong> — {note.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
