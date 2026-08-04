/**
 * Placing and moving stamps on a page (SGN-02).
 *
 * Fixes here:
 *  • Dragging called `updateAnnotation` on every pointer move and each one pushed an
 *    undo snapshot, so one drag filled the 50-deep stack and undo could not reach the
 *    state before it. Drags now open a history transaction and collapse to one entry.
 *  • Mouse-only: no pointer events (so no stylus or touch), and no keyboard nudge,
 *    which SGN-02 requires explicitly.
 *  • `alert()` when nothing was armed.
 */
import { useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import {
  addAnnotation,
  deleteAnnotation,
  documents,
  updateAnnotation,
  type Annotation
} from '../../core/store';
import { beginTransaction } from '../../core/history';
import { signaturePreviewUrl, signatures } from '../../core/signatures';
import { notify } from '../../core/notify';
import { activeStamp, signatureSuggestions } from '../tools/sign/state';
import styles from './AnnotationOverlay.module.css';

export interface AnnotationOverlayProps {
  docId: string;
  pageKey: string;
  width: number;
  height: number;
}

/** Default stamp footprints, as a fraction of the page. */
const DEFAULT_SIZE: Record<Annotation['type'], { width: number; height: number }> = {
  signature: { width: 0.28, height: 0.09 },
  text: { width: 0.24, height: 0.035 },
  date: { width: 0.16, height: 0.03 },
  check: { width: 0.04, height: 0.04 }
};

/** Arrow-key nudge, in fractions of the page. Shift is the coarse step. */
const NUDGE = 0.002;
const NUDGE_COARSE = 0.02;

export function AnnotationOverlay({ docId, pageKey, width, height }: AnnotationOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const doc = documents.value.find(d => d.id === docId);
  const armed = activeStamp.value;
  const stamps = (doc?.annotations ?? []).filter(a => a.pageKey === pageKey);
  const pageIndex = doc?.pages.findIndex(p => p.key === pageKey) ?? -1;
  const suggestions = signatureSuggestions.value.filter(s => s.pageIndex === pageIndex);

  const place = (x: number, y: number) => {
    if (!armed) return;
    const size = DEFAULT_SIZE[armed.type];
    addAnnotation(docId, {
      id: crypto.randomUUID(),
      pageKey,
      type: armed.type,
      x: Math.max(0, Math.min(1 - size.width, x - size.width / 2)),
      y: Math.max(0, Math.min(1 - size.height, y - size.height / 2)),
      ...size,
      data:
        armed.type === 'signature'
          ? (armed.signatureId ?? '')
          : armed.type === 'date'
            ? new Date().toLocaleDateString()
            : armed.type === 'check'
              ? '✓'
              : ''
    });
    // Disarm so a second click does not place a duplicate by accident.
    activeStamp.value = null;
  };

  return (
    <div
      ref={layerRef}
      className={`${styles.layer} ${armed ? styles.armed : ''}`}
      style={{ width: `${width}px`, height: `${height}px` }}
      onClick={event => {
        // Only a click on the empty layer places a stamp; a click on an existing one
        // is a selection, not a new placement.
        const layer = layerRef.current;
        if (!layer || event.target !== layer || !armed) return;
        const rect = layer.getBoundingClientRect();
        place((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
      }}
    >
      {stamps.map(stamp => (
        <Stamp key={stamp.id} docId={docId} stamp={stamp} layerRef={layerRef} />
      ))}

      {suggestions.map((suggestion, index) => (
        <button
          type="button"
          key={`suggestion-${index}`}
          className={styles.suggestion}
          style={{
            left: `${suggestion.x * 100}%`,
            top: `${suggestion.y * 100}%`,
            width: `${suggestion.width * 100}%`,
            height: `${suggestion.height * 100}%`
          }}
          onClick={event => {
            event.stopPropagation();
            if (!armed) {
              notify('info', 'Pick a signature or stamp first.', {
                detail: 'Choose one in the panel, then click here to place it.'
              });
              return;
            }
            place(suggestion.x + suggestion.width / 2, suggestion.y + suggestion.height / 2);
            signatureSuggestions.value = signatureSuggestions.value.filter(s => s !== suggestion);
          }}
        >
          Sign here
        </button>
      ))}
    </div>
  );
}

function Stamp({
  docId,
  stamp,
  layerRef
}: {
  docId: string;
  stamp: Annotation;
  layerRef: { current: HTMLDivElement | null };
}) {
  const [dragging, setDragging] = useState(false);

  /** Shared pointer drag for both moving and resizing. */
  const startDrag = (
    event: PointerEvent,
    apply: (dx: number, dy: number) => Partial<Annotation>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = event.clientX;
    const startY = event.clientY;
    setDragging(true);
    // One undo entry for the whole gesture, not one per pointer move.
    const tx = beginTransaction(`stamp-${stamp.id}`);

    const move = (moveEvent: PointerEvent) => {
      updateAnnotation(
        docId,
        stamp.id,
        apply((moveEvent.clientX - startX) / rect.width, (moveEvent.clientY - startY) / rect.height)
      );
    };
    const end = () => {
      setDragging(false);
      tx.end();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      updateAnnotation(docId, stamp.id, {
        x: Math.max(0, Math.min(1 - stamp.width, stamp.x + delta[0])),
        y: Math.max(0, Math.min(1 - stamp.height, stamp.y + delta[1]))
      });
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteAnnotation(docId, stamp.id);
    }
  };

  const signature =
    stamp.type === 'signature' ? signatures.value.find(s => s.id === stamp.data) : undefined;

  return (
    <div
      className={`${styles.stamp} ${dragging ? styles.dragging : ''}`}
      style={{
        left: `${stamp.x * 100}%`,
        top: `${stamp.y * 100}%`,
        width: `${stamp.width * 100}%`,
        height: `${stamp.height * 100}%`
      }}
      tabIndex={0}
      role="group"
      aria-label={`${stamp.type} stamp. Arrow keys move it, Shift for larger steps, Delete removes it.`}
      onKeyDown={onKeyDown}
      onPointerDown={event => {
        if ((event.target as HTMLElement).closest('button, input')) return;
        startDrag(event, (dx, dy) => ({
          x: Math.max(0, Math.min(1 - stamp.width, stamp.x + dx)),
          y: Math.max(0, Math.min(1 - stamp.height, stamp.y + dy))
        }));
      }}
    >
      {stamp.type === 'signature' &&
        (signature ? (
          <img className={styles.image} src={signaturePreviewUrl(signature)} alt="Signature" />
        ) : (
          <span className={styles.check}>Signature unavailable</span>
        ))}

      {stamp.type === 'check' && <span className={styles.check}>✓</span>}

      {(stamp.type === 'text' || stamp.type === 'date') && (
        <input
          className={styles.text}
          value={stamp.data}
          aria-label={stamp.type === 'date' ? 'Date text' : 'Stamp text'}
          onInput={event =>
            updateAnnotation(docId, stamp.id, {
              data: (event.target as HTMLInputElement).value
            })
          }
        />
      )}

      <button
        type="button"
        className={styles.remove}
        aria-label="Remove this stamp"
        onClick={event => {
          event.stopPropagation();
          deleteAnnotation(docId, stamp.id);
        }}
      >
        <X size={10} aria-hidden="true" />
      </button>

      <span
        className={styles.handle}
        role="presentation"
        onPointerDown={event =>
          startDrag(event, (dx, dy) => ({
            width: Math.max(0.02, Math.min(1 - stamp.x, stamp.width + dx)),
            height: Math.max(0.015, Math.min(1 - stamp.y, stamp.height + dy))
          }))
        }
      />
    </div>
  );
}
