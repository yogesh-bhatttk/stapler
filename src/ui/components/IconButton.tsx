import { JSX } from 'preact';
import { Icon } from './Icon';
import type { LucideIcon } from 'lucide-preact';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon'> {
  icon: LucideIcon;
  size?: 'default' | 'compact';
  active?: boolean;
  className?: string;
  disabled?: boolean;
}

export function IconButton({
  icon,
  size = 'default',
  active,
  className = '',
  disabled,
  ...props
}: IconButtonProps) {
  const classes = [styles.iconButton, styles[`size-${size}`], active && styles.active, className]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = props['aria-label'] || props.title;

  return (
    <button className={classes} disabled={disabled} aria-label={ariaLabel} {...props}>
      <Icon icon={icon} size={size === 'compact' ? 14 : 16} />
    </button>
  );
}
