import { ComponentChildren, JSX } from 'preact';
import styles from './Badge.module.css';

export type BadgeVariant = 'neutral' | 'success';

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  children: ComponentChildren;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = 'neutral', className = '', ...props }: BadgeProps) {
  const classes = [styles.badge, styles[`variant-${variant}`], className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
}
