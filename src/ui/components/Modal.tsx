/**
 * The one modal shell.
 *
 * Every dialog in the app previously rolled its own: a fixed `div` with an
 * `rgba()` backdrop, no focus trap, no Escape handler, and no focus restoration —
 * so a keyboard user could tab out of an open dialog into the page behind it, and a
 * screen-reader user was never told the dialog had opened.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { X } from 'lucide-preact';
import { IconButton } from './IconButton';
import { mergeRefs } from './mergeRefs';
import styles from './Modal.module.css';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Rendered in the footer. Put the primary action last. */
  footer?: ComponentChildren;
  size?: 'sm' | 'md' | 'lg';
  /** Set false for a dialog that must be answered, e.g. a confirmation. */
  dismissible?: boolean;
  icon?: ComponentChildren;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Modal = forwardRef<HTMLDivElement, ModalProps>(function Modal(
  { title, onClose, children, footer, size = 'md', dismissible = true, icon },
  ref
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;

    // Move focus into the dialog so the first Tab stays inside it.
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => el.offsetParent !== null
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Returning focus to where it came from is what makes the dialog feel
      // keyboard-native rather than a dead end.
      previouslyFocused?.focus?.();
    };
  }, [dismissible, onClose]);

  return (
    <div
      className={styles.scrim}
      onMouseDown={event => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={mergeRefs(dialogRef, ref)}
        className={`${styles.dialog} ${styles[`size-${size}`]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 className={styles.title} id={titleId}>
            {icon}
            {title}
          </h2>
          {dismissible && <IconButton icon={X} onClick={onClose} aria-label="Close dialog" />}
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
});
