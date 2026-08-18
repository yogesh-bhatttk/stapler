import { forwardRef, useRef, useState } from 'preact/compat';
import { ocrConsentRequest } from '../../core/notify';
import { writeModelBytes } from '../../core/opfs';
import { notifyError, notify } from '../../core/notify';
import { Button } from './Button';
import { Modal } from './Modal';

export const OcrConsentDialog = forwardRef<HTMLDivElement, Record<string, never>>(
  function OcrConsentDialog(_props, ref) {
    const request = ocrConsentRequest.value;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    if (!request) return null;

    const handleUploadClick = () => {
      fileInputRef.current?.click();
    };

    const handleFileChange = async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        let bytes = new Uint8Array(buffer);

        // Check if the file is already gzipped (magic bytes: 0x1F, 0x8B)
        if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
          const { gzipSync } = await import('fflate');
          bytes = gzipSync(bytes);
        }

        await writeModelBytes(request.lang, bytes);
        notify('success', 'Model uploaded', {
          detail: 'The offline language model was saved successfully.'
        });
        request.resolve('upload');
      } catch (err) {
        notifyError('Upload Model', err);
        setUploading(false);
      }
    };

    return (
      <Modal
        ref={ref}
        title={request.title}
        size="sm"
        onClose={() => request.resolve('cancel')}
        footer={
          <>
            <Button variant="tertiary" onClick={() => request.resolve('cancel')} disabled={uploading}>
              Cancel
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="secondary" onClick={handleUploadClick} disabled={uploading}>
              {uploading ? 'Uploading...' : 'Upload offline model'}
            </Button>
            <Button variant="primary" onClick={() => request.resolve('download')} disabled={uploading}>
              Download
            </Button>
          </>
        }
      >
        {request.body}
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          accept=".traineddata,.gz"
          onChange={handleFileChange}
        />
      </Modal>
    );
  }
);
