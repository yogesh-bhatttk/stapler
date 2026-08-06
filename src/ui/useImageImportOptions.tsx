import { useState } from 'preact/hooks';
import type { ImagesToPdfOptions } from '../core/operations';
import { isPdfFile } from '../core/import';
import { isSupportedImage } from '../core/image';
import { ImageOptionsDialog } from './components/ImageOptionsDialog';

export function useImageImportOptions() {
  const [pending, setPending] = useState<{
    count: number;
    resolve: (options: ImagesToPdfOptions | null) => void;
  } | null>(null);

  const requestOptions = async (files: File[]): Promise<ImagesToPdfOptions | undefined> => {
    const images = files.filter(f => !isPdfFile(f) && isSupportedImage(f));
    if (images.length === 0) return undefined;

    return new Promise<ImagesToPdfOptions | undefined>(resolve => {
      setPending({
        count: images.length,
        resolve: options => {
          setPending(null);
          resolve(options ?? undefined);
        }
      });
    });
  };

  const node = pending ? (
    <ImageOptionsDialog
      count={pending.count}
      onConfirm={pending.resolve}
      onCancel={() => pending.resolve(null)}
    />
  ) : null;

  return { requestOptions, node };
}
