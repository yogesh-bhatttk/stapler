/**
 * Toasts, progress, empty states, and the size delta.
 *
 * These replace `alert()` and `confirm()`, which blocked the main thread, could not
 * be themed, gave every failure the same voice, and — because they are browser
 * chrome — were invisible to the app's own accessibility tree.
 */
import type { ComponentChildren } from 'preact';
import { forwardRef } from 'preact/compat';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-preact';
import { dismissToast, toasts, type Toast, type ToastTone } from '../../core/notify';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { X } from 'lucide-preact';
import styles from './Feedback.module.css';

const TONE_ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert
};

function ToastCard({ toast }: { toast: Toast }) {
  const Icon = TONE_ICON[toast.tone];
  return (
    <div className={`${styles.toast} ${styles[`tone-${toast.tone}`]}`}>
      <Icon size={18} aria-hidden="true" />
      <div className={styles.toastBody}>
        <span className={styles.toastTitle}>{toast.title}</span>
        {toast.detail && <span className={styles.toastDetail}>{toast.detail}</span>}
        {toast.diagnostic && (
          <div className={styles.toastActions}>
            <Button
              size="compact"
              variant="tertiary"
              onClick={() => navigator.clipboard.writeText(toast.diagnostic ?? '')}
            >
              Copy diagnostic
            </Button>
          </div>
        )}
      </div>
      <IconButton
        icon={X}
        size="compact"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      />
    </div>
  );
}

/**
 * `role="status"` with `aria-live="polite"` so a screen reader announces failures
 * that a sighted user sees in the corner — the whole point of not using `alert`.
 */
export const ToastRegion = forwardRef<HTMLDivElement, Record<string, never>>(
  function ToastRegion(_props, ref) {
    const items = toasts.value;
    return (
      <div
        ref={ref}
        className={styles.toastRegion}
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map(toast => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
    );
  }
);

export interface ProgressProps {
  label: string;
  /** 0..1, or null while the total is genuinely unknown. */
  value: number | null;
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressProps>(function ProgressBar(
  { label, value },
  ref
) {
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div ref={ref} className={styles.progress}>
      <span className={styles.progressLabel}>{label}</span>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted while indeterminate, which is how assistive tech is told the
        // total is unknown rather than being told "0%".
        aria-valuenow={percent ?? undefined}
      >
        <div
          className={percent === null ? `${styles.bar} ${styles.indeterminate}` : styles.bar}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {percent !== null && <span className={styles.progressLabel}>{percent}%</span>}
    </div>
  );
});

export interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ComponentChildren;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, body, action },
  ref
) {
  return (
    <div ref={ref} className={styles.empty}>
      <span className={styles.emptyTitle}>{title}</span>
      {body && <span className={styles.emptyBody}>{body}</span>}
      {action}
    </div>
  );
});

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * `4.2MB → 1.1MB · −74%` (DESIGN-ADAPTATION §5). Shows "no reduction possible"
 * rather than a misleading −0% when there is nothing to gain (CMP-04).
 */
export const SizeDelta = forwardRef<HTMLSpanElement, { before: number; after: number }>(
  function SizeDelta({ before, after }, ref) {
    const fraction = before > 0 ? 1 - after / before : 0;
    const meaningful = fraction >= 0.005;
    return (
      <span ref={ref} className={styles.sizeDelta}>
        <span>{formatBytes(before)}</span>
        <span aria-hidden="true">→</span>
        <span>{formatBytes(after)}</span>
        <span className={meaningful ? styles.deltaGain : styles.deltaNone}>
          {meaningful ? `−${Math.round(fraction * 100)}%` : 'no reduction'}
        </span>
      </span>
    );
  }
);
