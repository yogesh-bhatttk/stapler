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
import { X, Copy } from 'lucide-preact';
import {
  addAnnotation,
  deleteAnnotation,
  duplicateAnnotationToAllPages,
  documents,
  updateAnnotation,
  type Annotation
} from '../../core/store';
import { beginTransaction } from '../../core/history';
import { signaturePreviewUrl, signatures } from '../../core/signatures';
import { notify } from '../../core/notify';
import { activeStamp, signatureSuggestions } from '../tools/sign/state';
import styles from './AnnotationOverlay.module.css';
import { useTranslation, currentLocale } from '../../core/i18n';

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
  check: { width: 0.04, height: 0.04 },
  'form-text': { width: 0.24, height: 0.04 },
  'form-checkbox': { width: 0.12, height: 0.035 },
  'form-radio': { width: 0.24, height: 0.035 }
};

/** Arrow-key nudge, in fractions of the page. Shift is the coarse step. */
const NUDGE = 0.002;
const NUDGE_COARSE = 0.02;

export function AnnotationOverlay({ docId, pageKey, width, height }: AnnotationOverlayProps) {
  const t = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const doc = documents.value.find(d => d.id === docId);
  const armed = activeStamp.value;
  const stamps = (doc?.annotations ?? []).filter(a => a.pageKey === pageKey);
  const pageIndex = doc?.pages.findIndex(p => p.key === pageKey) ?? -1;
  const suggestions = signatureSuggestions.value.filter(s => s.pageIndex === pageIndex);

  const place = (x: number, y: number) => {
    const currentStamp = activeStamp.value;
    if (!currentStamp) return;
    const size = DEFAULT_SIZE[currentStamp.type];
    const existingCount =
      (doc?.annotations ?? []).filter(a => a.type === currentStamp.type).length + 1;

    addAnnotation(docId, {
      id: crypto.randomUUID(),
      pageKey,
      type: currentStamp.type,
      x: Math.max(0, Math.min(1 - size.width, x - size.width / 2)),
      y: Math.max(0, Math.min(1 - size.height, y - size.height / 2)),
      ...size,
      data:
        currentStamp.type === 'signature'
          ? (currentStamp.signatureId ?? '')
          : currentStamp.type === 'date'
            ? new Date().toLocaleDateString(currentLocale.value ?? 'en-CA')
            : currentStamp.type === 'check'
              ? '✓'
              : '',
      fieldName:
        currentStamp.type === 'form-text'
          ? `text_${existingCount}`
          : currentStamp.type === 'form-checkbox'
            ? `check_${existingCount}`
            : currentStamp.type === 'form-radio'
              ? `radio_group`
              : undefined,
      exportValue: currentStamp.type === 'form-radio' ? `option_${existingCount}` : undefined
    });
    // Disarm so a second click does not place a duplicate by accident.
    activeStamp.value = null;
  };

  const onLayerKeyDown = (event: KeyboardEvent) => {
    // A real keyboard alternative to the pointer-only initial placement path.
    // Suggestions are buttons already, but an empty page needs an equally usable
    // route: focus the page, choose a stamp, then press Enter or Space to place it
    // in the centre where it can be nudged or resized afterwards.
    if (!activeStamp.value || event.target !== layerRef.current) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    place(0.5, 0.5);
  };

  return (
    <div
      ref={layerRef}
      className={`${styles.layer} ${armed ? styles.armed : ''}`}
      style={{ width: `${width}px`, height: `${height}px` }}
      tabIndex={armed ? 0 : -1}
      role={armed ? 'group' : undefined}
      aria-label={armed ? 'Stamp placement area. Press Enter to place in the centre.' : undefined}
      onKeyDown={onLayerKeyDown}
      onClick={event => {
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
          {t('Sign here')}
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
  const t = useTranslation();
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
      const next = apply(
        (moveEvent.clientX - startX) / rect.width,
        (moveEvent.clientY - startY) / rect.height
      );

      // Snapping logic for movement
      if (next.x !== undefined && stamp.width) {
        const cx = next.x + stamp.width / 2;
        if (Math.abs(cx - 0.5) < 0.02) next.x = 0.5 - stamp.width / 2;
        if (Math.abs(next.x - 0.05) < 0.02) next.x = 0.05;
        if (Math.abs(next.x + stamp.width - 0.95) < 0.02) next.x = 0.95 - stamp.width;
      }
      if (next.y !== undefined && stamp.height) {
        const cy = next.y + stamp.height / 2;
        if (Math.abs(cy - 0.5) < 0.02) next.y = 0.5 - stamp.height / 2;
        if (Math.abs(next.y - 0.05) < 0.02) next.y = 0.05;
        if (Math.abs(next.y + stamp.height - 0.95) < 0.02) next.y = 0.95 - stamp.height;
      }

      updateAnnotation(docId, stamp.id, next);
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

  const startRotateDrag = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + (stamp.x + stamp.width / 2) * rect.width;
    const cy = rect.top + (stamp.y + stamp.height / 2) * rect.height;

    setDragging(true);
    const tx = beginTransaction(`stamp-${stamp.id}`);

    const move = (moveEvent: PointerEvent) => {
      const angle = Math.atan2(moveEvent.clientY - cy, moveEvent.clientX - cx);
      // atan2 is 0 at right, PI/2 at bottom, -PI/2 at top. We want 0 at top.
      let deg = (angle * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;
      if (moveEvent.shiftKey) {
        deg = Math.round(deg / 45) * 45;
      }
      updateAnnotation(docId, stamp.id, { rotation: deg });
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
    const resizeStep = event.shiftKey ? 0.04 : 0.01;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const rotationStep = event.shiftKey ? 45 : 5;
      const rotation =
        (stamp.rotation ?? 0) + (event.key === 'ArrowLeft' ? -rotationStep : rotationStep);
      updateAnnotation(docId, stamp.id, { rotation: ((rotation % 360) + 360) % 360 });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && /^Arrow/.test(event.key)) {
      event.preventDefault();
      let width = stamp.width;
      let height = stamp.height;
      if (event.key === 'ArrowLeft') width -= resizeStep;
      if (event.key === 'ArrowRight') width += resizeStep;
      if (event.key === 'ArrowUp') height -= resizeStep;
      if (event.key === 'ArrowDown') height += resizeStep;
      if (stamp.type === 'signature' || stamp.type === 'check') {
        const aspect = stamp.width / stamp.height;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') height = width / aspect;
        else width = height * aspect;
      }
      updateAnnotation(docId, stamp.id, {
        width: Math.max(0.02, Math.min(1 - stamp.x, width)),
        height: Math.max(0.015, Math.min(1 - stamp.y, height))
      });
      return;
    }
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
        height: `${stamp.height * 100}%`,
        transform: stamp.rotation ? `rotate(${stamp.rotation}deg)` : undefined
      }}
      tabIndex={0}
      role="group"
      aria-label={`${stamp.type} stamp. Arrow keys move it; Control plus arrows resizes; Alt plus left or right rotates; Delete removes it.`}
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
          <span className={styles.check}>{t('Signature unavailable')}</span>
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

      {stamp.type === 'form-text' && (
        <div className={styles.formFieldContainer}>
          <span className={styles.formFieldTag}>{t('Text')}</span>
          <input
            className={styles.formInput}
            value={stamp.fieldName || ''}
            placeholder={t('Field name')}
            aria-label={t('Field name')}
            onKeyDown={e => e.stopPropagation()}
            onInput={event =>
              updateAnnotation(docId, stamp.id, {
                fieldName: (event.target as HTMLInputElement).value
              })
            }
          />
        </div>
      )}

      {stamp.type === 'form-checkbox' && (
        <div className={styles.formFieldContainer}>
          <input type="checkbox" disabled className={styles.checkboxPreview} />
          <input
            className={styles.formInput}
            value={stamp.fieldName || ''}
            placeholder={t('Name')}
            aria-label={t('Checkbox name')}
            onKeyDown={e => e.stopPropagation()}
            onInput={event =>
              updateAnnotation(docId, stamp.id, {
                fieldName: (event.target as HTMLInputElement).value
              })
            }
          />
        </div>
      )}

      {stamp.type === 'form-radio' && (
        <div className={styles.formFieldContainer}>
          <input type="radio" disabled className={styles.radioPreview} />
          <input
            className={styles.formInput}
            value={stamp.fieldName || ''}
            placeholder={t('Group')}
            aria-label={t('Radio group name')}
            onKeyDown={e => e.stopPropagation()}
            onInput={event =>
              updateAnnotation(docId, stamp.id, {
                fieldName: (event.target as HTMLInputElement).value
              })
            }
          />
          <input
            className={styles.formInput}
            value={stamp.exportValue || ''}
            placeholder={t('Value')}
            aria-label={t('Export value')}
            onKeyDown={e => e.stopPropagation()}
            onInput={event =>
              updateAnnotation(docId, stamp.id, {
                exportValue: (event.target as HTMLInputElement).value
              })
            }
          />
        </div>
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

      <button
        type="button"
        className={styles.duplicate}
        aria-label="Duplicate to all pages"
        title={t('Duplicate to all pages')}
        onClick={event => {
          event.stopPropagation();
          duplicateAnnotationToAllPages(docId, stamp.id);
        }}
      >
        <Copy size={10} aria-hidden="true" />
      </button>

      <span
        className={styles.handle}
        role="presentation"
        onPointerDown={event => {
          const aspect = stamp.width / stamp.height;
          startDrag(event, (dx, dy) => {
            let newWidth = stamp.width + dx;
            let newHeight = stamp.height + dy;

            if (stamp.type === 'signature' || stamp.type === 'check') {
              if (Math.abs(dx) > Math.abs(dy)) {
                newHeight = newWidth / aspect;
              } else {
                newWidth = newHeight * aspect;
              }
            }

            newWidth = Math.max(0.02, Math.min(1 - stamp.x, newWidth));
            newHeight = Math.max(0.015, Math.min(1 - stamp.y, newHeight));

            return { width: newWidth, height: newHeight };
          });
        }}
      />

      <span className={styles.rotateHandle} role="presentation" onPointerDown={startRotateDrag} />
    </div>
  );
}
