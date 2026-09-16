import { translate } from '../../core/i18n';
/**
 * DS-05 — the drop zone.
 */
import { useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { UploadCloud } from 'lucide-preact';
import { platform } from '../../platform/current';
import { PDF_AND_IMAGES, acceptToInputAccept, type OpenedFile } from '../../platform/index';
import { SUPPORTED_FORMATS } from '../../core/import';
import { importFilesAsDocuments, pickAndImportFiles } from '../../core/open-document';
import { ProgressBar } from './Feedback';
import { useImageImportOptions } from '../useImageImportOptions';
import styles from './DropZone.module.css';

export interface DropZoneProps {
  onImported: () => void;
}

export const DropZone = forwardRef<HTMLLabelElement, DropZoneProps>(function DropZone(
  { onImported },
  ref
) {
  const [state, setState] = useState<'idle' | 'active' | 'reject' | 'busy'>('idle');
  const [progress, setProgress] = useState<{ label: string; value: number | null } | null>(null);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { requestOptions, node } = useImageImportOptions();

  const accepts = (transfer: DataTransfer | null) =>
    Array.from(transfer?.items ?? []).some(
      item =>
        item.kind === 'file' && (item.type === 'application/pdf' || item.type.startsWith('image/'))
    );

  const process = async (files: File[], handles?: OpenedFile[]) => {
    if (files.length === 0) return;

    const result = await importFilesAsDocuments(files, {
      handles,
      requestImageOptions: requestOptions,
      onImportStart: () => {
        setState('busy');
        setProgress({ label: 'Reading files', value: null });
      },
      onProgress: (value, label) => setProgress({ label, value })
    });

    setState('idle');
    setProgress(null);
    depth.current = 0;
    if (result.imported > 0) onImported();
  };

  const browse = async () => {
    const result = await pickAndImportFiles({
      requestImageOptions: requestOptions,
      onImportStart: () => {
        setState('busy');
        setProgress({ label: 'Reading files', value: null });
      },
      onProgress: (value, label) => setProgress({ label, value })
    });
    setState('idle');
    setProgress(null);
    depth.current = 0;
    if (result.imported > 0) onImported();
  };

  return (
    <>
      <label
        ref={ref}
        className={[styles.dropzone, state !== 'idle' ? styles[state] : '']
          .filter(Boolean)
          .join(' ')}
        aria-label={translate('Choose PDFs or images to open')}
        aria-busy={state === 'busy'}
        onClick={event => {
          if (!platform.supportsFileSystemAccess) return;
          event.preventDefault();
          void browse();
        }}
        onDragEnter={event => {
          event.preventDefault();
          event.stopPropagation();
          depth.current += 1;
          setState(accepts(event.dataTransfer) ? 'active' : 'reject');
        }}
        onDragOver={event => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = accepts(event.dataTransfer) ? 'copy' : 'none';
          }
        }}
        onDragLeave={event => {
          event.preventDefault();
          event.stopPropagation();
          depth.current -= 1;
          if (depth.current <= 0) setState('idle');
        }}
        onDrop={event => {
          event.preventDefault();
          depth.current = 0;
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) {
            setState('idle');
            return;
          }
          void process(files);
        }}
      >
        <input
          ref={inputRef}
          className="srOnly"
          type="file"
          multiple
          accept={acceptToInputAccept(PDF_AND_IMAGES)}
          aria-label={translate('Choose PDFs or images to open')}
          onChange={event => {
            const input = event.target as HTMLInputElement;
            const files = Array.from(input.files ?? []);
            input.value = '';
            if (files.length > 0) void process(files);
          }}
        />
        <UploadCloud size={40} aria-hidden="true" />
        {state === 'busy' && progress ? (
          <ProgressBar label={progress.label} value={progress.value} />
        ) : (
          <>
            <span className={styles.title}>
              {state === 'reject' ? 'Only PDFs and images' : 'Drop PDFs or images here'}
            </span>
            <span className={styles.hint}>
              {state === 'reject'
                ? `${SUPPORTED_FORMATS} are supported.`
                : 'or choose files — nothing is uploaded'}
            </span>
          </>
        )}
      </label>
      {node}
    </>
  );
});
