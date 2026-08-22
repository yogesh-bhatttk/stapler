/**
 * The signature library and stamp picker (SGN-01, SGN-02, SGN-04).
 *
 * `Detect signature lines` previously passed the store document id to the render
 * worker, which expects its own handle, so it threw on every use.
 */
import { useEffect } from 'preact/hooks';
import {
  Calendar,
  Check,
  CheckSquare,
  CircleDot,
  Plus,
  ScanSearch,
  Trash2,
  Type
} from 'lucide-preact';
import { useState } from 'preact/hooks';
import { activeDoc } from '../../../core/store';
import {
  checkSignatureIntegrity,
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
import { parseFormula } from '../../../core/formula';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Checkbox, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { FlattenOption } from '../FlattenOption';
import { SignatureModal } from './SignatureModal';
import {
  activeStamp,
  signatureSuggestions,
  formFields,
  formValues,
  formulas,
  signatureIntegrity,
  type StampType
} from './state';
import { useJob } from '../../useJob';
import styles from './SignPanel.module.css';
import { useTranslation } from '../../../core/i18n';

const FORM_FIELDS: { type: StampType; labelKey: string; icon: typeof Type }[] = [
  { type: 'form-text', labelKey: 'Text field', icon: Type },
  { type: 'form-checkbox', labelKey: 'Checkbox', icon: CheckSquare },
  { type: 'form-radio', labelKey: 'Radio button', icon: CircleDot }
];

const STAMPS: { type: StampType; labelKey: string; icon: typeof Type }[] = [
  { type: 'text', labelKey: 'tool.sign.stampText', icon: Type },
  { type: 'date', labelKey: 'tool.sign.stampDate', icon: Calendar },
  { type: 'check', labelKey: 'tool.sign.stampCheck', icon: Check }
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
      signatureIntegrity.value = null;
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
      // SGN-09 — a structural check only, independent of whether the document
      // has *fillable* fields, so it runs alongside rather than inside the
      // form-fields fetch above.
      checkSignatureIntegrity(bytes)
        .then(report => {
          signatureIntegrity.value = report;
        })
        .catch(() => {
          signatureIntegrity.value = null;
        });
    });
  }, [doc]);

  useEffect(() => {
    formValues.value = {};
    formulas.value = [];
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

      {signatureIntegrity.value?.hasSignature && (
        <p
          className={
            signatureIntegrity.value.intact
              ? `${panelStyles.note} ${panelStyles.noteInfo}`
              : panelStyles.note
          }
        >
          {signatureIntegrity.value.intact
            ? t(
                'This document has a digital signature, and nothing was appended to the file after it was signed.'
              )
            : t(
                'This document has a digital signature, but bytes were appended to the file after it was signed — it may have been modified since.'
              )}
        </p>
      )}

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Signatures')}</h2>
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
                  aria-label={`${t('tool.sign.useThisPrefix')} ${signature.kind} ${t('tool.sign.signatureSuffix')}`}
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
                      aria-label={t('tool.sign.deleteSignature')}
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
        <h2 className={panelStyles.title}>{t('Initials')}</h2>
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
                  aria-label={`${t('tool.sign.useThisPrefix')} ${signature.kind} ${t('tool.sign.initialSuffix')}`}
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
                      aria-label={t('tool.sign.deleteInitials')}
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
        <h2 className={panelStyles.title}>{t('Other stamps')}</h2>
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
                {t(stamp.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className={panelStyles.section}>
        <h2 className={panelStyles.title}>{t('Create form fields')}</h2>
        <div className={styles.stampGrid}>
          {FORM_FIELDS.map(stamp => {
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
                {t(stamp.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {!formFields.value?.isXfa &&
        (formFields.value?.fields.filter(f => f.type === 'TextField').length ?? 0) > 0 && (
          <div className={panelStyles.section}>
            <h2 className={panelStyles.title}>{t('Calculated fields')}</h2>
            <p className={panelStyles.description}>
              {t(
                'Make a text field show the sum, difference, product, or quotient of other fields — e.g. "subtotal + tax".'
              )}
            </p>
            {(formFields.value?.fields ?? [])
              .filter(field => field.type === 'TextField')
              .map(field => {
                const existing = formulas.value.find(f => f.target === field.name);
                const fieldNames = (formFields.value?.fields ?? []).map(f => f.name);
                const parsed =
                  existing && existing.source.trim()
                    ? parseFormula(existing.source, fieldNames)
                    : null;
                return (
                  <div
                    key={field.name}
                    className={panelStyles.section}
                    style={{ paddingTop: 0, paddingBottom: 0 }}
                  >
                    <Checkbox
                      label={t('Calculate "{name}"', { name: field.name })}
                      checked={!!existing}
                      onChange={checked => {
                        formulas.value = checked
                          ? [
                              ...formulas.value.filter(f => f.target !== field.name),
                              { target: field.name, source: '' }
                            ]
                          : formulas.value.filter(f => f.target !== field.name);
                      }}
                    />
                    {existing && (
                      <>
                        <TextInput
                          value={existing.source}
                          placeholder={t('e.g. subtotal + tax')}
                          aria-label={t('Formula for "{name}"', { name: field.name })}
                          onInput={e => {
                            const source = (e.target as HTMLInputElement).value;
                            formulas.value = formulas.value.map(f =>
                              f.target === field.name ? { ...f, source } : f
                            );
                          }}
                        />
                        {parsed && !parsed.ok && (
                          <p className={`${panelStyles.note} ${panelStyles.noteWarning}`}>
                            {parsed.error}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        )}

      <p className={panelStyles.description}>
        {armed ? t('tool.sign.placementHintActive') : t('tool.sign.placementHintIdle')}
      </p>

      <Button variant="tertiary" icon={ScanSearch} onClick={detect} disabled={!doc}>
        {t('Detect signature lines')}
      </Button>

      <FlattenOption mode="sign" />

      <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
        {t('These are stamped signature images. Stapler makes no claim about legal validity.')}
      </p>

      {modalType && (
        <SignatureModal onClose={() => setModalType(null)} isInitials={modalType === 'initials'} />
      )}
    </>
  );
}
