import { translate } from '../../../core/i18n';
/**
 * Creating a signature: draw, type, or import (SGN-01).
 *
 * Two acceptance criteria drove the changes here. "Exports with genuine alpha (no
 * white box)" — so nothing composites a background, and an imported photo gets its
 * paper-white turned into real transparency. And "stylus pressure where available" —
 * so strokes are pointer events with `pressure` varying the width, not mouse events.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Trash2 } from 'lucide-preact';
import { saveSignature } from '../../../core/signatures';
import { notify, notifyError } from '../../../core/notify';
import { removeWhiteBackground, trimTransparentToPng } from '../../../core/image';
import { DOC_SIGNATURE_STROKE } from '../../../core/doc-colors';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { TextInput } from '../../components/Field';
import styles from './SignatureModal.module.css';

type Tab = 'draw' | 'type' | 'image';

export function SignatureModal({
  onClose,
  isInitials
}: {
  onClose: () => void;
  isInitials?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('draw');

  return (
    <Modal
      title={isInitials ? 'Create initials' : 'Create a signature'}
      onClose={onClose}
      size="md"
    >
      <div className={styles.tabs} role="tablist" aria-label={translate('Signature source')}>
        {(['draw', 'type', 'image'] as Tab[]).map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={`tabpanel-${name}`}
            id={`tab-${name}`}
            tabIndex={tab === name ? 0 : -1}
            className={`${styles.tab} ${tab === name ? styles.tabActive : ''}`}
            onClick={() => setTab(name)}
          >
            {name === 'draw' ? 'Draw' : name === 'type' ? 'Type' : 'Import'}
          </button>
        ))}
      </div>

      <div id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'draw' && <DrawTab onDone={onClose} isInitials={isInitials} />}
        {tab === 'type' && <TypeTab onDone={onClose} isInitials={isInitials} />}
        {tab === 'image' && <ImageTab onDone={onClose} isInitials={isInitials} />}
      </div>
    </Modal>
  );
}

/** Saves a canvas as a trimmed, transparent PNG. */
async function persist(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  kind: 'draw' | 'type' | 'image',
  onDone: () => void,
  isInitials?: boolean
) {
  const bitmap = await createImageBitmap(canvas as unknown as ImageBitmapSource);
  try {
    const trimmed = await trimTransparentToPng(bitmap);
    if (!trimmed) {
      notify('warning', translate('Nothing to save.'), { detail: 'The canvas is empty.' });
      return;
    }
    const saved = await saveSignature({
      kind,
      png: trimmed.png,
      width: trimmed.width,
      height: trimmed.height,
      purpose: isInitials ? 'initials' : 'signature'
    });
    if (saved) {
      notify('success', translate('Signature saved.'), { detail: 'It stays on this device.' });
      onDone();
    }
  } finally {
    bitmap.close();
  }
}

function DrawTab({ onDone, isInitials }: { onDone: () => void; isInitials?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasInk, setHasInk] = useState(false);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Back the canvas at device resolution so the exported PNG is not soft.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = DOC_SIGNATURE_STROKE;
  }, []);

  const point = (event: PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const stroke = (event: PointerEvent, start: boolean) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = point(event);
    // A stylus reports 0.5 by default and a real pressure when it has one; a mouse
    // reports 0 while up and 0.5 while down.
    const pressure = event.pressure > 0 ? event.pressure : 0.5;
    ctx.lineWidth = 1 + pressure * 3;
    if (start) {
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
    ctx.lineTo(x, y);
    ctx.stroke();
    // Keep the path anchored so line width can change mid-stroke.
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  return (
    <>
      <div className={styles.pad}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label={translate('Draw your signature')}
          onPointerDown={event => {
            drawing.current = true;
            setHasInk(true);
            canvasRef.current?.setPointerCapture(event.pointerId);
            stroke(event, true);
          }}
          onPointerMove={event => {
            if (drawing.current) stroke(event, false);
          }}
          onPointerUp={() => (drawing.current = false)}
          onPointerCancel={() => (drawing.current = false)}
        />
        <span className={styles.baseline} />
      </div>

      <div className={styles.actions}>
        <Button
          variant="tertiary"
          icon={Trash2}
          disabled={!hasInk}
          onClick={() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            setHasInk(false);
          }}
        >
          Clear
        </Button>
        <Button
          variant="primary"
          disabled={!hasInk}
          onClick={() => {
            if (canvasRef.current) void persist(canvasRef.current, 'draw', onDone, isInitials);
          }}
        >
          Save signature
        </Button>
      </div>
    </>
  );
}

function TypeTab({ onDone, isInitials }: { onDone: () => void; isInitials?: boolean }) {
  const [text, setText] = useState('');

  const save = async () => {
    const canvas = new OffscreenCanvas(1200, 300);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = "150px 'Brush Script MT', 'Segoe Script', 'Bradley Hand', cursive";
    ctx.fillStyle = DOC_SIGNATURE_STROKE;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text.trim(), canvas.width / 2, canvas.height / 2);
    await persist(canvas, 'type', onDone, isInitials);
  };

  return (
    <>
      <input
        className={styles.typeInput}
        value={text}
        placeholder="Your name"
        aria-label={translate('Signature text')}
        onInput={event => setText((event.target as HTMLInputElement).value)}
      />
      <p>The face is whatever script font your system provides — Stapler ships no webfonts.</p>
      <div className={styles.actions}>
        <Button variant="primary" disabled={!text.trim()} onClick={save}>
          Save signature
        </Button>
      </div>
    </>
  );
}

function ImageTab({ onDone, isInitials }: { onDone: () => void; isInitials?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropWhite, setDropWhite] = useState(true);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  const save = async () => {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      try {
        // A photographed signature is ink on white paper. Without this it exports as
        // an opaque white rectangle over the page.
        const source = dropWhite ? await removeWhiteBackground(bitmap) : bitmap;
        if (!source) return;
        await persist(source as OffscreenCanvas, 'image', onDone, isInitials);
      } finally {
        bitmap.close();
      }
    } catch (err) {
      notifyError('signature.import', err);
    }
  };

  return (
    <>
      <div className={styles.fileRow}>
        <TextInput
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={translate('Signature image file')}
          onChange={event => {
            const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
            setFile(chosen);
            setPreview(chosen ? URL.createObjectURL(chosen) : null);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={dropWhite}
            onChange={event => setDropWhite((event.target as HTMLInputElement).checked)}
          />{' '}
          Make the white background transparent
        </label>
      </div>

      {preview && (
        <div className={styles.preview}>
          <img src={preview} alt="Imported signature preview" />
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="primary" disabled={!file} onClick={save}>
          Save signature
        </Button>
      </div>
    </>
  );
}
