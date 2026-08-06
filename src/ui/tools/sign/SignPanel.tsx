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
import {
  currentDocumentBytes,
  detectSignatureLines,
  getFormFields
} from '../../../core/operations';
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
import { activeStamp, signatureSuggestions, formFields, formValues, type StampType } from './state';
import { useJob } from '../../useJob';
import styles from './SignPanel.module.css';
import { useTranslation } from '../../../core/i18n';

const STAMPS: { type: StampType; label: string; icon: typeof Type }[] = [
  { type: 'text', label: 'Text', icon: Type },
  { type: 'date', label: 'Date', icon: Calendar },
  { type: 'check', label: 'Check', icon: Check }
];

export function SignPanel() {
  const t = useTranslation();
  const [modalType, setModalType] = useState<'signature' | 'initials' | null>(null);
  const armed = activeStamp.value;
  const { run } = useJob();
  const doc = activeDoc.value;

  useEffect(() => {
    void loadSignatures();
  }, []);

  useEffect(() => {
    if (!doc) {
      formFields.value = null;
      return;
    }
    // Only query fields if the document properties imply they exist
    void currentDocumentBytes().then(bytes => {
      getFormFields(bytes)
        .then(fields => {
          formFields.value = fields;
        })
        .catch(() => {
          formFields.value = null;
        });
    });
  }, [doc]);

  useEffect(() => {
    formValues.value = {};
  }, [doc?.id]);

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
      {formFields.value?.isXfa && (
        <p className={`${panelStyles.note} ${panelStyles.noteWarning}`}>
          {t(
            'This is an XFA form. Interactive filling is not supported. Use the stamp tools below to place text and signatures instead.'
          )}
        </p>
      )}
      {!formFields.value?.isXfa && (formFields.value?.fields.length ?? 0) > 0 && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t(
            'This document contains interactive form fields. You can click on them in the page to type and fill them out.'
          )}
        </p>
      )}

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>{t('Signatures')}</h3>
        <div className={styles.list}>
          {signatures.value
            .filter(s => s.purpose !== 'initials')
            .map(signature => {
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
        <Button variant="secondary" icon={Plus} onClick={() => setModalType('signature')}>
          {t('Create a signature')}
        </Button>
      </div>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>{t('Initials')}</h3>
        <div className={styles.list}>
          {signatures.value
            .filter(s => s.purpose === 'initials')
            .map(signature => {
              const active = armed?.type === 'signature' && armed.signatureId === signature.id;
              return (
                <div
                  key={signature.id}
                  className={`${styles.card} ${active ? styles.cardActive : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-label={`Use this ${signature.kind} initial`}
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
                      aria-label="Delete these initials"
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
        <Button variant="secondary" icon={Plus} onClick={() => setModalType('initials')}>
          {t('Create initials')}
        </Button>
      </div>

      <div className={panelStyles.section}>
        <h3 className={panelStyles.title}>{t('Other stamps')}</h3>
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
        {t('Detect signature lines')}
      </Button>

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t('These are stamped signature images. Stapler makes no claim about legal validity.')}
      </p>

      {modalType && (
        <SignatureModal onClose={() => setModalType(null)} isInitials={modalType === 'initials'} />
      )}
    </>
  );
}
