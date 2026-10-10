/**
 * The `window.confirm` replacement. Rendered once in the app shell; anything can
 * raise one by awaiting `confirmAction()` from core/notify.
 */
import { forwardRef } from 'preact/compat';
import { confirmRequest } from '../../core/notify';
import { Button } from './Button';
import { Modal, requestKey } from './Modal';
import styles from './InfoModals.module.css';

export const ConfirmDialog = forwardRef<HTMLDivElement, Record<string, never>>(
  function ConfirmDialog(_props, ref) {
    const request = confirmRequest.value;
    if (!request) return null;

    return (
      <Modal
        key={requestKey(request)}
        ref={ref}
        title={request.title}
        size="sm"
        // A confirmation must be answered: dismissing it would leave the caller's
        // promise unresolved, so Escape and the scrim resolve it as "no" — unless
        // "no" itself acts (session restore's "Start fresh" deletes the saved
        // session), in which case the dialog is not dismissible at all and only
        // an explicit button answers it (AUDIT-2026-10-10 UI2).
        dismissible={request.dismissible}
        onClose={() => {
          if (request.dismissible) request.resolve(false);
        }}
        footer={
          <>
            <Button
              variant="tertiary"
              data-autofocus={request.initialFocus === 'cancel' ? '' : undefined}
              onClick={() => request.resolve(false)}
            >
              {request.cancelLabel}
            </Button>
            <Button
              variant={request.tone === 'danger' ? 'danger' : 'primary'}
              data-autofocus={request.initialFocus === 'confirm' ? '' : undefined}
              onClick={() => request.resolve(true)}
            >
              {request.confirmLabel}
            </Button>
          </>
        }
      >
        {request.body}
        {request.details && request.details.length > 0 && (
          <ul className={styles.steps}>
            {/* Keyed by position: lines can repeat (two shared files with one name). */}
            {request.details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </Modal>
    );
  }
);
