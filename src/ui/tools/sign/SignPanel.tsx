/**
 * The signature library and stamp picker (SGN-01, SGN-02, SGN-04).
 *
 * `Detect signature lines` previously passed the store document id to the render
 * worker, which expects its own handle, so it threw on every use.
 */
import { useEffect } from 'preact/hooks';
import { Calendar, Check, Plus, ScanSearch, Trash2, Type } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes, detectSignatureLines } from '../../../core/operations';
import {
  deleteSignature,
  loadSignatures,
  signaturePreviewUrl,
  signatures
} from '../../../core/signatures';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { panelStyles } from '../../shell/OptionsPanel';
import { SignatureModal } from './SignatureModal';
import { activeStamp, signatureSuggestions, type StampType } from './state';
import { useJob } from '../../useJob';
import styles from './SignPanel.module.css';

const STAMPS: { type: StampType; label: string; icon: typeof Type }[] = [
  { type: 'text', label: 'Text', icon: Type },
  { type: 'date', label: 'Date', icon: Calendar },
  { type: 'check', label: 'Check', icon: Check }
];

export function SignPanel() {
  const [showModal, setShowModal] = useState(false);
  const armed = activeStamp.value;
  const { run } = useJob();
  const doc = activeDoc.value;

  useEffect(() => {
    void loadSignatures();
  }, []);

  const detect = () =>
    run({ label: 'Looking for signature lines', scope: 'sign.detect' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const found = await detectSignatureLines(bytes, job);
      signatureSuggestions.value = found;
      notify(
        found.length > 0 ? 'info' : 'warning',
        found.length > 0
          ? `Suggested ${found.length} place(s) to sign.`
          : 'No signature lines found.',
        {
          detail:
            found.length > 0
              ? 'Pick a signature, then click a highlighted box on the page.'
              : 'Place your signature by clicking the page directly.'
        }
      );
    });

  return (
    <>
      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>Signatures</h3>
        <div className={styles.list}>
          {signatures.value.map(signature => {
            const active = armed?.type === 'signature' && armed.signatureId === signature.id;
            return (
              <div
                key={signature.id}
                className={`${styles.card} ${active ? styles.cardActive : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`Use this ${signature.kind} signature`}
                onClick={() =>
                  (activeStamp.value = active
                    ? null
                    : { type: 'signature', signatureId: signature.id })
                }
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  activeStamp.value = active
                    ? null
                    : { type: 'signature', signatureId: signature.id };
                }}
              >
                <img src={signaturePreviewUrl(signature)} alt="" />
                <span className={styles.cardRemove}>
                  <IconButton
                    icon={Trash2}
                    size="compact"
                    aria-label="Delete this signature"
                    onClick={event => {
                      event.stopPropagation();
                      void deleteSignature(signature.id);
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
        <Button variant="secondary" icon={Plus} onClick={() => setShowModal(true)}>
          Create a signature
        </Button>
      </div>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>Other stamps</h3>
        <div className={styles.stampGrid}>
          {STAMPS.map(stamp => {
            const active = armed?.type === stamp.type;
            return (
              <button
                key={stamp.type}
                type="button"
                aria-pressed={active}
                className={`${styles.stampButton} ${active ? styles.stampActive : ''}`}
                onClick={() => (activeStamp.value = active ? null : { type: stamp.type })}
              >
                <stamp.icon size={18} aria-hidden="true" />
                {stamp.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className={panelStyles.description}>
        {armed
          ? 'Click the page to place it. Arrow keys nudge; hold Shift for larger steps.'
          : 'Pick a signature or stamp, then click the page.'}
      </p>

      <Button variant="tertiary" icon={ScanSearch} onClick={detect} disabled={!doc}>
        Detect signature lines
      </Button>

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        These are stamped signature images. Stapler makes no claim about legal validity.
      </p>

      {showModal && <SignatureModal onClose={() => setShowModal(false)} />}
    </>
  );
}
