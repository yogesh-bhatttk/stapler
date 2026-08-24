/**
 * RED-03 — the verification report.
 *
 * The previous implementation reported "Verification passed. 0 instances of redacted
 * text found" via `alert()`, having only checked strings the caller happened to
 * supply. A region drawn by hand carries no string, so it verified nothing while
 * saying it had — the worst possible failure for a feature whose entire value is the
 * guarantee. Every region now gets a row, pass or fail, with the reason.
 *
 * "Copy report" used to be a fire-and-forget `navigator.clipboard.writeText()`
 * with no `await`, no `.catch()`, and no confirmation. Clipboard writes are
 * refused often enough to matter — a non-secure context, a denied permission, a
 * window that lost focus — and every one of those refusals looked exactly like
 * success: the button clicked, nothing was said, and the user pasted whatever had
 * been on the clipboard before. For the one screen whose whole purpose is telling
 * the user what is provably true about their document, silently losing the
 * evidence is the wrong failure. It is awaited and reported both ways now.
 */
import { CheckCircle2, XCircle } from 'lucide-preact';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { redactionReport } from './state';
import styles from './VerificationReport.module.css';
import { translate, useTranslation } from '../../../core/i18n';
import { notify } from '../../../core/notify';
import type { RegionVerdict } from '../../../core/operations';

/**
 * The report as plain text, for the clipboard.
 *
 * Exported so the export can be tested without a clipboard: the string is the
 * artefact the user takes away from this screen, and it has to carry the same
 * verdicts the table shows.
 *
 * `verdict.detail` is passed through verbatim. It is not a UI string — it is the
 * verification engine's own account of what it measured, assembled per region in
 * `core/operations.ts` from the numbers it read, and `translate()` refuses
 * interpolated keys by design (see `core/i18n`): a lookup on a sentence built
 * around a page number and a percentage can never match a dictionary entry, so
 * wrapping it would only pretend to be translatable. The labels around it are
 * translated.
 */
export function verificationReportText(verdicts: RegionVerdict[]): string {
  const failed = verdicts.filter(verdict => !verdict.pass).length;
  return [
    translate('Stapler redaction verification'),
    translate('regions: {count}', { count: verdicts.length }),
    translate('failed: {count}', { count: failed }),
    '',
    ...verdicts.map(
      (verdict, index) =>
        `${index + 1}. [${verdict.pass ? translate('PASS') : translate('FAIL')}] ` +
        `${translate('page {page}', { page: verdict.region.pageIndex + 1 })} — ${verdict.detail}`
    )
  ].join('\n');
}

/** How a region is named in the table: its search string, or how it was drawn. */
function regionLabel(verdict: RegionVerdict): string {
  if (verdict.region.text) return `"${verdict.region.text}"`;
  return verdict.region.points ? translate('Drawn shape') : translate('Drawn region');
}

/**
 * Puts the report on the clipboard, and says which way it went.
 *
 * Exported for the same reason `verificationReportText` is: both outcomes are
 * behaviour worth pinning down, and the failing one is the one that used to be
 * invisible.
 */
export async function copyVerificationReport(verdicts: RegionVerdict[]): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(verificationReportText(verdicts));
    notify('success', translate('Verification report copied to the clipboard.'));
    return true;
  } catch (error) {
    notify('danger', translate('The verification report could not be copied.'), {
      detail: translate(
        'This browser refused clipboard access — it needs a secure context and permission. ' +
          'The report is still on screen; select the table and copy it by hand.'
      ),
      diagnostic: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
    return false;
  }
}

export function VerificationReport() {
  const t = useTranslation();
  const report = redactionReport.value;
  if (!report) return null;

  const failed = report.verdicts.filter(verdict => !verdict.pass).length;

  return (
    <div className={panelStyles.section}>
      <h2 className={panelStyles.title}>{t('Verification')}</h2>
      <p className={report.verified ? styles.pass : styles.fail}>
        {report.verified
          ? t('All {count} region(s) verified.', { count: report.verdicts.length })
          : t('{failed} of {count} region(s) could not be verified — nothing was saved.', {
              failed,
              count: report.verdicts.length
            })}
      </p>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('Page')}</th>
            <th scope="col">{t('Region')}</th>
            <th scope="col">{t('Result')}</th>
          </tr>
        </thead>
        <tbody>
          {report.verdicts.map((verdict, index) => (
            <tr key={index}>
              <td>{verdict.region.pageIndex + 1}</td>
              <td>{regionLabel(verdict)}</td>
              <td>
                <span className={verdict.pass ? styles.pass : styles.fail}>
                  {verdict.pass ? (
                    <CheckCircle2 size={14} aria-hidden="true" />
                  ) : (
                    <XCircle size={14} aria-hidden="true" />
                  )}
                  {verdict.pass ? t('Pass') : t('Fail')}
                </span>
                {/* Engine prose, not a UI string — see `verificationReportText`. */}
                <span className={styles.detail}>{verdict.detail}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Button
        variant="tertiary"
        size="compact"
        onClick={() => void copyVerificationReport(report.verdicts)}
      >
        {t('Copy report')}
      </Button>
    </div>
  );
}
