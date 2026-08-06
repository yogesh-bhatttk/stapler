import { useState } from 'preact/hooks';
import type { ImagesToPdfOptions } from '../../core/operations';
import { Button } from './Button';
import { Modal } from './Modal';
import { Field, Select } from './Field';
import { useTranslation } from '../../core/i18n';
import styles from './ImageOptionsDialog.module.css';

export interface ImageOptionsDialogProps {
  count: number;
  onConfirm: (options: ImagesToPdfOptions) => void;
  onCancel: () => void;
}

export function ImageOptionsDialog({ count, onConfirm, onCancel }: ImageOptionsDialogProps) {
  const t = useTranslation();
  const [pageSize, setPageSize] = useState<ImagesToPdfOptions['pageSize']>('original');
  const [orientation, setOrientation] = useState<ImagesToPdfOptions['orientation']>('auto');
  const [margin, setMargin] = useState<number>(0);
  const [quality, setQuality] = useState<number>(0.9);

  return (
    <Modal
      title={t(`Import ${count} image${count === 1 ? '' : 's'}`)}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm({ pageSize, orientation, margin, quality })}
          >
            {t('Import')}
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <Field label={t('Page size')}>
          {id => (
            <Select
              id={id}
              value={pageSize as string}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onChange={val => setPageSize(val as any)}
              options={[
                { value: 'original', label: t('Original image size') },
                { value: 'a4', label: t('A4') },
                { value: 'letter', label: t('US Letter') }
              ]}
            />
          )}
        </Field>

        <Field label={t('Orientation')}>
          {id => (
            <Select
              id={id}
              value={orientation}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onChange={val => setOrientation(val as any)}
              disabled={pageSize === 'original'}
              options={[
                { value: 'auto', label: t('Auto (match image)') },
                { value: 'portrait', label: t('Portrait') },
                { value: 'landscape', label: t('Landscape') }
              ]}
            />
          )}
        </Field>

        <Field label={t('Margin (pt)')}>
          {id => (
            <input
              id={id}
              type="number"
              min="0"
              max="200"
              value={margin}
              disabled={pageSize === 'original'}
              onChange={e => setMargin(Math.max(0, parseInt(e.currentTarget.value, 10) || 0))}
            />
          )}
        </Field>

        <Field label={t('Quality')}>
          {id => (
            <Select
              id={id}
              value={quality}
              onChange={val => setQuality(Number(val))}
              options={[
                { value: 1.0, label: t('100% (Lossless)') },
                { value: 0.9, label: t('90% (High)') },
                { value: 0.75, label: t('75% (Medium)') },
                { value: 0.5, label: t('50% (Low)') }
              ]}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
