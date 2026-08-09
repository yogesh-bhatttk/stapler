/**
 * DS-05 — the drop zone.
 */
import { useRef, useState } from 'preact/hooks';
import { UploadCloud } from 'lucide-preact';
import { platform } from '../../platform/current';
import { PDF_AND_IMAGES, acceptToInputAccept, type OpenedFile } from '../../platform/index';
import { importFiles, isPdfFile } from '../../core/import';
import { addDocument, makePageRefs } from '../../core/store';
import { resetHistory } from '../../core/history';
import { notify, notifyError } from '../../core/notify';
import { ProgressBar } from './Feedback';
import { isSupportedImage } from '../../core/image';
import { useImageImportOptions } from '../useImageImportOptions';
import styles from './DropZone.module.css';

export interface DropZoneProps {
  onImported: () => void;
}

export function DropZone({ onImported }: DropZoneProps) {
  const [state, setState] = useState<'idle' | 'active' | 'reject' | 'busy'>('idle');
  const [progress, setProgress] = useState<{ label: string; value: number | null } | null>(null);
  const depth = useRef(0);
  const { requestOptions, node } = useImageImportOptions();

  const accepts = (transfer: DataTransfer | null) =>
    Array.from(transfer?.items ?? []).some(
      item =>
        item.kind === 'file' && (item.type === 'application/pdf' || item.type.startsWith('image/'))
    );

  const process = async (files: File[], handles?: OpenedFile[]) => {
    if (files.length === 0) return;

    let imageOptions = undefined;
    const hasImages = files.some(f => !isPdfFile(f) && isSupportedImage(f));
    if (hasImages) {
      const options = await requestOptions(files);
      if (!options) {
        setState('idle');
        return; // user cancelled
      }
      imageOptions = options;
    }

    setState('busy');
    setProgress({ label: 'Reading files', value: null });
    try {
      const outcome = await importFiles(
        files,
        {
          onProgress: (value, label) => setProgress({ label, value })
        },
        imageOptions
      );

      for (const imported of outcome.imported) {
        let handle: OpenedFile | undefined = undefined;
        if (handles) {
          const index = files.indexOf(imported.originalFile);
          if (index !== -1) {
            handle = handles[index];
          }
        }
        addDocument({
          id: crypto.randomUUID(),
          name: imported.source.name,
          pages: makePageRefs(imported.source.id, imported.source.pageCount),
          annotations: [],
          dirty: false,
          sourceHandle: handle?.writable ? { fileId: handle.id, writable: true } : undefined
        });
        for (const warning of imported.warnings) {
          notify('warning', imported.source.name, { detail: warning });
        }
      }
      for (const failure of outcome.failures) {
        notify('danger', `Could not open ${failure.name}`, { detail: failure.message });
      }

      if (outcome.imported.length > 0) {
        resetHistory();
        onImported();
      }
    } catch (err) {
      notifyError('import', err);
    } finally {
      setState('idle');
      setProgress(null);
      depth.current = 0;
    }
  };

  const browse = async () => {
    try {
      const opened = await platform.openFiles({ multiple: true, accept: PDF_AND_IMAGES });
      if (opened.length === 0) return;
      for (const handle of opened) {
        if (handle.persistable) await platform.persistHandle(handle);
      }
      await process(await Promise.all(opened.map(handle => handle.getFile())), opened);
    } catch (err) {
      notifyError('import.browse', err);
    }
  };

  return (
    <label
      className={[styles.dropzone, state !== 'idle' ? styles[state] : ''].filter(Boolean).join(' ')}
      aria-busy={state === 'busy'}
      onClick={event => {
        if (!platform.supportsFileSystemAccess) return;
        event.preventDefault();
        void browse();
      }}
      onDragEnter={event => {
        event.preventDefault();
        depth.current += 1;
        setState(accepts(event.dataTransfer) ? 'active' : 'reject');
      }}
      onDragOver={event => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = accepts(event.dataTransfer) ? 'copy' : 'none';
        }
      }}
      onDragLeave={event => {
        event.preventDefault();
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
        className="srOnly"
        type="file"
        multiple
        accept={acceptToInputAccept(PDF_AND_IMAGES)}
        aria-label="Choose PDFs or images to open"
        onChange={event => {
          const input = event.target as HTMLInputElement;
          const files = Array.from(input.files ?? []);
          input.value = '';
          if (files.length > 0) void process(files);
        }}
      />
      <UploadCloud size={40} aria-hidden="true" />
      {node}
      {state === 'busy' && progress ? (
        <ProgressBar label={progress.label} value={progress.value} />
      ) : (
        <>
          <span className={styles.title}>
            {state === 'reject' ? 'Only PDFs and images' : 'Drop PDFs or images here'}
          </span>
          <span className={styles.hint}>
            {state === 'reject'
              ? 'PDF, PNG, JPEG, WebP, and GIF are supported.'
              : 'or choose files — nothing is uploaded'}
          </span>
        </>
      )}
    </label>
  );
}
