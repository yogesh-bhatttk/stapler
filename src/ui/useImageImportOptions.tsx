import { useRef, useState } from 'preact/hooks';
import type { ImagesToPdfOptions } from '../core/operations';
import { isPdfFile } from '../core/import';
import { isSupportedImage } from '../core/image';
import { ImageOptionsDialog } from './components/ImageOptionsDialog';

interface PendingRequest {
  count: number;
  resolve: (options: ImagesToPdfOptions | null) => void;
}

export function useImageImportOptions() {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  // `setPending` only ever shows one dialog; a second `requestOptions` call
  // before the first resolves used to overwrite it outright, discarding the
  // first request's `resolve` (and its caller's `await`) forever. A queue —
  // same fix shape as `createModalQueue` in `core/notify.ts` — shows requests
  // one at a time instead of clobbering whichever is currently pending.
  const queueRef = useRef<PendingRequest[]>([]);

  const showNext = () => {
    queueRef.current.shift(); // Remove the completed request
    setPending(queueRef.current[0] ?? null); // Show the next one (if any)
  };

  const requestOptions = async (files: File[]): Promise<ImagesToPdfOptions | undefined> => {
    const images = files.filter(f => !isPdfFile(f) && isSupportedImage(f));
    if (images.length === 0) return undefined;

    return new Promise<ImagesToPdfOptions | undefined>(resolve => {
      const request: PendingRequest = {
        count: images.length,
        resolve: options => {
          resolve(options ?? undefined);
          showNext();
        }
      };
      queueRef.current.push(request);
      if (queueRef.current.length === 1) setPending(request);
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
