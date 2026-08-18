/**
 * RED-06 — the password-protection controls.
 *
 * Lives inside the Metadata & privacy panel because that is where the document's
 * disclosure settings already are, but the copy is careful to separate the two:
 * scrubbing *removes* what a file reveals, this *adds* encryption on the way out,
 * and neither can open a document Stapler does not already hold in the clear.
 */
import { Lock } from 'lucide-preact';
import { Checkbox, Field, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { useTranslation } from '../../../core/i18n';
import { protection, protectionIssue, type ProtectionState } from './state';

export function ProtectSection() {
  const t = useTranslation();
  const state = protection.value;
  const set = (patch: Partial<ProtectionState>) => (protection.value = { ...state, ...patch });
  const issue = protectionIssue();

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>
        <Lock size={14} aria-hidden="true" /> {t('Password protection')}
      </h2>
      <p className={panelStyles.description}>
        {t(
          'Encrypts the exported file with AES-256. The document open here is unaffected, and Stapler still cannot open or unlock a file it was not given the password for.'
        )}
      </p>

      <Checkbox
        label={t('Password-protect exported files')}
        checked={state.enabled}
        onChange={enabled => set({ enabled })}
      />

      {state.enabled && (
        <>
          <Field label={t('Password to open')}>
            {id => (
              <TextInput
                id={id}
                type="password"
                autocomplete="new-password"
                value={state.userPassword}
                onInput={event => set({ userPassword: (event.target as HTMLInputElement).value })}
              />
            )}
          </Field>
          <Field label={t('Confirm password')}>
            {id => (
              <TextInput
                id={id}
                type="password"
                autocomplete="new-password"
                value={state.confirmPassword}
                onInput={event =>
                  set({ confirmPassword: (event.target as HTMLInputElement).value })
                }
              />
            )}
          </Field>
          <Field
            label={t('Owner password (optional)')}
            hint={t('Grants full rights. Leave empty to reuse the password above.')}
          >
            {id => (
              <TextInput
                id={id}
                type="password"
                autocomplete="new-password"
                value={state.ownerPassword}
                onInput={event => set({ ownerPassword: (event.target as HTMLInputElement).value })}
              />
            )}
          </Field>

          <div role="group" aria-label={t('Permissions granted without the owner password')}>
            <Checkbox
              label={t('Allow printing')}
              checked={state.allowPrinting}
              onChange={allowPrinting => set({ allowPrinting })}
            />
            <Checkbox
              label={t('Allow copying text')}
              checked={state.allowCopying}
              onChange={allowCopying => set({ allowCopying })}
            />
            <Checkbox
              label={t('Allow editing')}
              checked={state.allowModifying}
              onChange={allowModifying => set({ allowModifying })}
            />
          </div>

          {issue ? (
            <p className={panelStyles.note} role="alert">
              {t(issue)} {t('Exporting is blocked until this is fixed.')}
            </p>
          ) : (
            <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
              {t(
                'Every export from any tool will require this password until you turn it off or open a different document. There is no way to recover it — Stapler keeps no copy.'
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
