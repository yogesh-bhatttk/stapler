/**
 * A small removable or toggleable tag. Distinct from `Badge`, which is a static
 * status label — a Chip is always either dismissible or selectable, never inert.
 */
import type { ComponentChildren } from 'preact';
import { forwardRef } from 'preact/compat';
import { X } from 'lucide-preact';
import { Icon } from './Icon';
import styles from './Chip.module.css';

export interface ChipProps {
  children: ComponentChildren;
  /** Renders a trailing remove control; the label is derived from `children`. */
  onRemove?: () => void;
  removeLabel?: string;
  /** Renders as a toggle button instead of a static/dismissible tag. */
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

/** The root is a `<button>` when `onClick` is passed, a `<span>` otherwise — the
 * forwarded ref's element type follows whichever one actually renders. */
export const Chip = forwardRef<HTMLButtonElement | HTMLSpanElement, ChipProps>(function Chip(
  { children, onRemove, removeLabel, selected, onClick, disabled },
  ref
) {
  const classes = [styles.chip, selected && styles.selected].filter(Boolean).join(' ');

  const label = <span className={styles.label}>{children}</span>;

  if (onClick) {
    return (
      <button
        ref={ref as import('preact').Ref<HTMLButtonElement>}
        type="button"
        className={classes}
        aria-pressed={selected ?? false}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }

  return (
    <span ref={ref as import('preact').Ref<HTMLSpanElement>} className={classes}>
      {label}
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          aria-label={removeLabel ?? 'Remove'}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </span>
  );
});
