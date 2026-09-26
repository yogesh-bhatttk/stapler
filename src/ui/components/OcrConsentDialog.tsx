import { forwardRef, useRef, useState } from 'preact/compat';
import { ocrConsentRequest } from '../../core/notify';
import { writeModelBytes } from '../../core/opfs';
import { notifyError } from '../../core/notify';
import { Button } from './Button';
import { Modal, requestKey } from './Modal';
import { useTranslation } from '../../core/i18n';

export const OcrConsentDialog = forwardRef<HTMLDivElement, Record<string, never>>(
  function OcrConsentDialog(_props, ref) {
    const t = useTranslation();
    const request = ocrConsentRequest.value;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    if (!request) return null;

    // One uploaded file can only cover one language, so the affordance is
    // hidden for a combined run that still needs more than one model.
    const allowUpload = request.langs.length === 1;

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

        await writeModelBytes(request.langs[0], bytes);
        // No "saved" toast: `runOcr` trial-loads the file in the OCR engine
        // first (its progress label says so) and discards it, re-showing this
        // dialog with the reason, if it will not load (audit 2026-09-25 CNV-8).
        // This component instance survives into a re-shown dialog, so its
        // busy state and file input must be reset for a second attempt.
        setUploading(false);
        (e.target as HTMLInputElement).value = '';
        request.resolve('upload');
      } catch (err) {
        notifyError('Upload Model', err);
        setUploading(false);
      }
    };

    return (
      <Modal
        key={requestKey(request)}
        ref={ref}
        title={request.title}
        size="sm"
        onClose={() => request.resolve('cancel')}
        footer={
          <>
            <Button
              variant="tertiary"
              onClick={() => request.resolve('cancel')}
              disabled={uploading}
            >
              {t('Cancel')}
            </Button>
            <div style={{ flex: 1 }} />
            {allowUpload && (
              <Button variant="secondary" onClick={handleUploadClick} disabled={uploading}>
                {uploading ? t('Uploading...') : t('Upload offline model')}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => request.resolve('download')}
              disabled={uploading}
            >
              {t('Download and run OCR')}
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
