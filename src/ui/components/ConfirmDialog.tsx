/**
 * The `window.confirm` replacement. Rendered once in the app shell; anything can
 * raise one by awaiting `confirmAction()` from core/notify.
 */
import { confirmRequest } from '../../core/notify';
import { Button } from './Button';
import { Modal } from './Modal';

export function ConfirmDialog() {
  const request = confirmRequest.value;
  if (!request) return null;

  return (
    <Modal
      title={request.title}
      size="sm"
      // A confirmation must be answered: dismissing it would leave the caller's
      // promise unresolved, so Escape and the scrim resolve it as "no".
      onClose={() => request.resolve(false)}
      footer={
        <>
          <Button variant="tertiary" onClick={() => request.resolve(false)}>
            {request.cancelLabel}
          </Button>
          <Button
            variant={request.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => request.resolve(true)}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      {request.body}
    </Modal>
  );
}
