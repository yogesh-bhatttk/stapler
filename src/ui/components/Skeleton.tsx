/**
 * A loading placeholder. Always decorative — the loading state itself must be
 * announced by whatever container renders a group of these (e.g. `aria-busy` or
 * an `aria-live` status message), not by the placeholder shapes themselves.
 */
import { forwardRef } from 'preact/compat';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  variant?: 'text' | 'block' | 'circle';
  width?: number | string;
  height?: number | string;
  className?: string;
}

export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(function Skeleton(
  { variant = 'block', width, height, className = '' },
  ref
) {
  return (
    <span
      ref={ref}
      className={`${styles.skeleton} ${styles[variant]} ${className}`}
      aria-hidden="true"
      style={{ width, height }}
    />
  );
});
