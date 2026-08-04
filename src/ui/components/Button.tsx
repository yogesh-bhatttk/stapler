import { ComponentChildren, JSX } from 'preact';
import { Icon } from './Icon';
import type { LucideIcon } from 'lucide-preact';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'compact';

export interface ButtonProps extends JSX.HTMLAttributes<HTMLButtonElement> {
  children?: ComponentChildren;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  className?: string;
  disabled?: boolean;
}

export function Button({
  children,
  variant = 'secondary',
  size = 'default',
  icon,
  iconPosition = 'left',
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const classes = [styles.button, styles[`variant-${variant}`], styles[`size-${size}`], className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled} {...props}>
      {icon && iconPosition === 'left' && <Icon icon={icon} size={size === 'compact' ? 14 : 16} />}
      {children}
      {icon && iconPosition === 'right' && <Icon icon={icon} size={size === 'compact' ? 14 : 16} />}
    </button>
  );
}
