import { ComponentChildren, JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import styles from './Badge.module.css';

export type BadgeVariant = 'neutral' | 'success';

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  children: ComponentChildren;
  variant?: BadgeVariant;
  className?: string;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { children, variant = 'neutral', className = '', ...props }: BadgeProps,
  ref
) {
  const classes = [styles.badge, styles[`variant-${variant}`], className].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={classes} {...props}>
      {children}
    </span>
  );
});
