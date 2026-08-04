/**
 * RED-03 — the verification report.
 *
 * The previous implementation reported "Verification passed. 0 instances of redacted
 * text found" via `alert()`, having only checked strings the caller happened to
 * supply. A region drawn by hand carries no string, so it verified nothing while
 * saying it had — the worst possible failure for a feature whose entire value is the
 * guarantee. Every region now gets a row, pass or fail, with the reason.
 */
import { CheckCircle2, XCircle } from 'lucide-preact';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/OptionsPanel';
import { redactionReport } from './state';
import styles from './VerificationReport.module.css';

export function VerificationReport() {
  const report = redactionReport.value;
  if (!report) return null;

  const failed = report.verdicts.filter(verdict => !verdict.pass).length;

  const asText = () =>
    [
      `Stapler redaction verification`,
      `regions: ${report.verdicts.length}`,
      `failed: ${failed}`,
      `rasterised pages: ${report.rasterizedPages.map(p => p + 1).join(', ') || 'none'}`,
      '',
      ...report.verdicts.map(
        (verdict, index) =>
          `${index + 1}. [${verdict.pass ? 'PASS' : 'FAIL'}] page ${verdict.region.pageIndex + 1} — ${verdict.detail}`
      )
    ].join('\n');

  return (
    <div className={panelStyles.section}>
      <h3 className={panelStyles.title}>Verification</h3>
      <p className={report.verified ? styles.pass : styles.fail}>
        {report.verified
          ? `All ${report.verdicts.length} region(s) verified.`
          : `${failed} of ${report.verdicts.length} region(s) could not be verified — nothing was saved.`}
      </p>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col">Region</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {report.verdicts.map((verdict, index) => (
            <tr key={index}>
              <td>{verdict.region.pageIndex + 1}</td>
              <td>{verdict.region.text ? `"${verdict.region.text}"` : 'Drawn region'}</td>
              <td>
                <span className={verdict.pass ? styles.pass : styles.fail}>
                  {verdict.pass ? (
                    <CheckCircle2 size={14} aria-hidden="true" />
                  ) : (
                    <XCircle size={14} aria-hidden="true" />
                  )}
                  {verdict.pass ? 'Pass' : 'Fail'}
                </span>
                <span className={styles.detail}>{verdict.detail}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Button
        variant="tertiary"
        size="compact"
        onClick={() => navigator.clipboard.writeText(asText())}
      >
        Copy report
      </Button>
    </div>
  );
}
