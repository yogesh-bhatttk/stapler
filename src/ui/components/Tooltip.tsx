/**
 * A hover/focus tooltip. Shows on focus as well as hover — a tooltip that only
 * responds to `mouseenter` is invisible to a keyboard user, which is the most
 * common way this primitive gets built wrong.
 */
import { cloneElement, isValidElement, type VNode } from 'preact';
import { forwardRef } from 'preact/compat';
import { useId, useRef, useState } from 'preact/hooks';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** A single element — its props are extended with `aria-describedby`. */
  children: VNode<{ 'aria-describedby'?: string }>;
}

export const Tooltip = forwardRef<HTMLSpanElement, TooltipProps>(function Tooltip(
  { content, placement = 'top', children },
  ref
) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = () => {
    clearTimeout(hideTimer.current);
    setVisible(true);
  };
  // A short delay survives moving focus/pointer between the trigger and the
  // tooltip itself without a visible flicker.
  const hide = () => {
    hideTimer.current = setTimeout(() => setVisible(false), 80);
  };

  if (!isValidElement(children)) return children;

  const trigger = cloneElement(children, {
    'aria-describedby': visible ? id : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    }
  });

  return (
    <span ref={ref} className={styles.wrapper}>
      {trigger}
      {visible && (
        <span role="tooltip" id={id} className={`${styles.bubble} ${styles[placement]}`}>
          {content}
        </span>
      )}
    </span>
  );
});
