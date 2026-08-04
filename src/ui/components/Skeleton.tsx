/**
 * A loading placeholder. Always decorative — the loading state itself must be
 * announced by whatever container renders a group of these (e.g. `aria-busy` or
 * an `aria-live` status message), not by the placeholder shapes themselves.
 */
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  variant?: 'text' | 'block' | 'circle';
  width?: number | string;
  height?: number | string;
  className?: string;
}

export function Skeleton({ variant = 'block', width, height, className = '' }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${styles[variant]} ${className}`}
      aria-hidden="true"
      style={{ width, height }}
    />
  );
}
